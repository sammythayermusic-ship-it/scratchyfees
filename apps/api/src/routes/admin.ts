import {
  decimalToScaledExact,
  PAYOUT_RATE_MAX_PPM,
  PAYOUT_RATE_MIN_PPM,
  scaledToDecimal,
} from '@scratchy/core'
import { desc, eq, inArray, like, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { config, events, jackpot, payoutAttempts, payouts, rounds, sweeps, wallets } from '../db/schema'
import { HARD_PAUSE_REASONS, type HardPauseReason } from '../engine/pauses'
import type { Services } from '../services'
import { adminAuthorized, fail, jsonSafe } from './http'

/**
 * Admin (PLAN §3.2 "token-gated: pause/resume, set PAYOUT_RATE, view breaker events") + ops helpers.
 * Every route requires `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare); without an
 * ADMIN_TOKEN configured the admin API is disabled entirely.
 */
export async function registerAdminRoutes(root: FastifyInstance, s: Services) {
  // An encapsulated plugin under the /api/admin prefix: the auth hook runs for EVERY route registered in it,
  // decided by the router's match — never by string-matching the raw URL (which percent-encoding bypasses,
  // e.g. /api/%61dmin/status).
  await root.register(
    async (app) => {
      app.addHook('onRequest', async (req, reply) => {
        if (!adminAuthorized(req, s.config.env.ADMIN_TOKEN))
          return fail(reply, 401, 'unauthorized', 'admin token required')
      })
      await adminRoutes(app, s)
    },
    { prefix: '/api/admin' },
  )
}

async function adminRoutes(app: FastifyInstance, s: Services) {
  const db = s.database.db

  app.get('/status', async () => {
    const [rate] = await db.select().from(config).where(eq(config.key, 'payout_rate'))
    const problem = await db
      .select()
      .from(payouts)
      .where(inArray(payouts.status, ['held', 'failed', 'failed_permanent', 'sending']))
      .orderBy(desc(payouts.id))
      .limit(100)
    const recentEvents = await db
      .select()
      .from(events)
      .where(
        or(
          ...[
            'breaker.%',
            'pause.%',
            'resume.%',
            'invariant.%',
            'sweep.%',
            'payout.%',
            'monitor.%',
            'config.%',
            'mint.%',
            'engine.%',
            'admin.%',
            'round.skipped%',
          ].map((k) => like(events.kind, k)),
        ),
      )
      .orderBy(desc(events.id))
      .limit(100)
    const recentSweeps = await db.select().from(sweeps).orderBy(desc(sweeps.id)).limit(10)
    const recentRounds = await db.select().from(rounds).orderBy(desc(rounds.id)).limit(12)
    const [queue] = (
      await db.execute<{ queued: number; sending: number }>(sql`
        SELECT COUNT(*) FILTER (WHERE status = 'queued')::int AS queued, COUNT(*) FILTER (WHERE status = 'sending')::int AS sending
        FROM payouts`)
    ).rows
    const statusCounts = Object.fromEntries(
      (
        await db.execute<{ status: string; n: number }>(
          sql`SELECT status, COUNT(*)::int AS n FROM payouts GROUP BY status`,
        )
      ).rows.map((r) => [r.status, r.n]),
    )
    // latest attempt per problem payout (signature → Solscan, status, error)
    const attempts = problem.length
      ? await db
          .select()
          .from(payoutAttempts)
          .where(
            inArray(
              payoutAttempts.payoutId,
              problem.map((p) => p.id),
            ),
          )
          .orderBy(desc(payoutAttempts.attempt))
      : []
    const attemptInfo = new Map<
      string,
      { attempts: number; lastSignature: string; lastStatus: string; lastError: string | null }
    >()
    for (const a of attempts) {
      const k = String(a.payoutId)
      const cur = attemptInfo.get(k)
      if (cur) cur.attempts++
      else
        attemptInfo.set(k, {
          attempts: 1,
          lastSignature: a.signature,
          lastStatus: a.status,
          lastError: a.error,
        })
    }
    const env = s.config.env
    return jsonSafe({
      serverTime: new Date().toISOString(),
      statusCounts,
      thresholds: {
        minGasSol: scaledToDecimal(s.config.economy.minGasLamports, 9),
        minPoolReserveUsd: s.config.economy.minPoolReserveUsd,
        reserveHysteresis: env.RESERVE_HYSTERESIS,
        minCreatorGasSol: env.MIN_CREATOR_GAS_SOL,
      },
      mint: await s.mintState(),
      pauses: s.pauses.list(),
      monitor: s.monitor.state(),
      oracle: s.oracle.peek(),
      payoutRate: {
        effective: rate?.value ?? scaledToDecimal(s.config.economy.payoutRatePpm, 6),
        default: scaledToDecimal(s.config.economy.payoutRatePpm, 6),
        min: scaledToDecimal(PAYOUT_RATE_MIN_PPM, 6),
        max: scaledToDecimal(PAYOUT_RATE_MAX_PPM, 6),
        appliesFrom: 'next round',
      },
      queue,
      problemPayouts: problem.map((p) => ({ ...p, attempt: attemptInfo.get(String(p.id)) ?? null })),
      events: recentEvents,
      sweeps: recentSweeps,
      rounds: recentRounds.map((r) => ({
        ...r,
        serverSeed: r.status === 'ended' || r.status === 'skipped' ? r.serverSeed : null,
      })),
      wallets: { prize: s.prizeAddress, creator: s.creatorAddress, ops: s.opsAddress },
      cluster: s.config.env.CHAIN_MODE === 'memory' ? 'memory' : s.config.env.SOLANA_CLUSTER,
    })
  })

  /** every mutating admin action carries a human note and is recorded (events table + Telegram) */
  const noteOf = (body: unknown): string | null => {
    const n = String((body as { note?: unknown } | null)?.note ?? '').trim()
    return n ? n.slice(0, 300) : null
  }
  const audit = (kind: string, message: string, data?: Record<string, unknown>) =>
    s.alerter.notify({ kind: `admin.${kind}`, severity: 'warn', message, immediate: true, data })

  app.post('/pause', async (req, reply) => {
    const note = noteOf(req.body)
    if (!note) return fail(reply, 400, 'note_required', 'say why you are pausing (note)')
    await s.pauses.set('manual', note)
    return { ok: true, pauses: s.pauses.list() }
  })

  app.post('/resume', async (req, reply) => {
    const body = (req.body ?? {}) as { reason?: unknown; note?: unknown }
    const reason = String(body.reason ?? 'manual') as HardPauseReason
    if (!HARD_PAUSE_REASONS.includes(reason))
      return fail(reply, 400, 'bad_request', `reason must be one of ${HARD_PAUSE_REASONS.join(', ')}`)
    const note = noteOf(body)
    if (!note) return fail(reply, 400, 'note_required', 'say what you checked before resuming (note)')
    // resuming a mint_changed pause is the operator's review: the current mint state becomes the accepted one
    if (reason === 'mint_changed') await s.acknowledgeMint()
    await s.pauses.clear(reason, note)
    s.worker.wake()
    return { ok: true, pauses: s.pauses.list() }
  })

  app.post('/payout-rate', async (req, reply) => {
    const raw = String((req.body as { rate?: unknown })?.rate ?? '')
    let ppm: bigint
    try {
      ppm = decimalToScaledExact(raw, 6)
    } catch {
      return fail(reply, 400, 'bad_request', 'rate must be a decimal like 0.005')
    }
    if (ppm < PAYOUT_RATE_MIN_PPM || ppm > PAYOUT_RATE_MAX_PPM) {
      return fail(reply, 400, 'out_of_range', 'PAYOUT_RATE must be within 0.3%–0.8% (0.003–0.008)')
    }
    const value = scaledToDecimal(ppm, 6)
    await db
      .insert(config)
      .values({ key: 'payout_rate', value })
      .onConflictDoUpdate({ target: config.key, set: { value, updatedAt: new Date() } })
    s.alerter.notify({
      kind: 'config.payout_rate',
      severity: 'warn',
      message: `PAYOUT_RATE set to ${value} (applies next round)`,
      immediate: true,
    })
    return { ok: true, payoutRate: value, appliesFrom: 'next round' }
  })

  app.post('/payouts/:id/retry', async (req, reply) => {
    const raw = (req.params as { id: string }).id
    if (!/^\d+$/.test(raw)) return fail(reply, 400, 'bad_request', 'invalid id')
    const note = noteOf(req.body)
    if (!note) return fail(reply, 400, 'note_required', 'say why this retry should succeed now (note)')
    const id = BigInt(raw)
    const res = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(payouts).where(eq(payouts.id, id)).for('update')
      if (!p || (p.status !== 'failed' && p.status !== 'failed_permanent'))
        return { error: 'not_retryable' as const }
      if (p.status === 'failed_permanent' && p.kind === 'jackpot') {
        // Decision B: a permanently failed jackpot went BACK into the pot — take it out again before re-paying,
        // or the same PUMP would be both owed to this winner and offered to the next one
        const [pot] = await tx.select().from(jackpot).where(eq(jackpot.id, 1)).for('update')
        if (!pot || pot.amountRaw < p.amountRaw) return { error: 'pot_short' as const }
        await tx
          .update(jackpot)
          .set({ amountRaw: pot.amountRaw - p.amountRaw, updatedAt: new Date() })
          .where(eq(jackpot.id, 1))
      }
      const [u] = await tx
        .update(payouts)
        .set({ status: 'queued', nextAttemptAt: null, error: null, simFailures: 0 })
        .where(eq(payouts.id, id))
        .returning()
      return { payout: u! }
    })
    if ('error' in res) {
      return res.error === 'pot_short'
        ? fail(
            reply,
            409,
            'pot_short',
            'the jackpot pot no longer holds this amount (it was paid out since) — resolve manually',
          )
        : fail(reply, 409, 'not_retryable', 'only failed / failed_permanent payouts can be retried')
    }
    audit(
      'retry',
      `payout #${id} (${res.payout.kind}, ${res.payout.amountRaw} raw → ${res.payout.wallet}) re-queued: ${note}`,
      {
        payoutId: id.toString(),
      },
    )
    s.worker.wake()
    return jsonSafe({ ok: true, payout: res.payout })
  })

  app.post('/wallets/:address/clear-handle', async (req, reply) => {
    const address = (req.params as { address: string }).address
    const [w] = await db
      .update(wallets)
      .set({ xHandle: null })
      .where(eq(wallets.address, address))
      .returning()
    if (!w) return fail(reply, 404, 'not_found', 'no such wallet')
    audit('clear_handle', `X handle cleared for ${address}${noteOf(req.body) ? `: ${noteOf(req.body)}` : ''}`)
    return { ok: true }
  })
}

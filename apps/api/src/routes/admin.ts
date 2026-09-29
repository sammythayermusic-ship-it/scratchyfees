import {
  decimalToScaledExact,
  PAYOUT_RATE_MAX_PPM,
  PAYOUT_RATE_MIN_PPM,
  scaledToDecimal,
} from '@scratchy/core'
import { desc, eq, inArray, like, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { config, events, payouts, rounds, sweeps, wallets } from '../db/schema'
import { HARD_PAUSE_REASONS, type HardPauseReason } from '../engine/pauses'
import type { Services } from '../services'
import { adminAuthorized, fail, jsonSafe } from './http'

/**
 * Admin (PLAN §3.2 "token-gated: pause/resume, set PAYOUT_RATE, view breaker events") + ops helpers.
 * Every route requires `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare); without an
 * ADMIN_TOKEN configured the admin API is disabled entirely.
 */
export async function registerAdminRoutes(app: FastifyInstance, s: Services) {
  const db = s.database.db
  const token = s.config.env.ADMIN_TOKEN

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/admin')) return
    if (!adminAuthorized(req, token)) return fail(reply, 401, 'unauthorized', 'admin token required')
  })

  app.get('/api/admin/status', async () => {
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
          like(events.kind, 'breaker.%'),
          like(events.kind, 'pause.%'),
          like(events.kind, 'resume.%'),
          like(events.kind, 'invariant.%'),
          like(events.kind, 'sweep.%'),
          like(events.kind, 'payout.fail%'),
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
    return jsonSafe({
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
      problemPayouts: problem,
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

  app.post('/api/admin/pause', async (req) => {
    const note = String((req.body as { note?: unknown })?.note ?? 'paused from admin panel').slice(0, 300)
    await s.pauses.set('manual', note)
    return { ok: true, pauses: s.pauses.list() }
  })

  app.post('/api/admin/resume', async (req, reply) => {
    const body = (req.body ?? {}) as { reason?: unknown; note?: unknown }
    const reason = String(body.reason ?? 'manual') as HardPauseReason
    if (!HARD_PAUSE_REASONS.includes(reason))
      return fail(reply, 400, 'bad_request', `reason must be one of ${HARD_PAUSE_REASONS.join(', ')}`)
    // resuming a mint_changed pause is the operator's review: the current mint state becomes the accepted one
    if (reason === 'mint_changed') await s.acknowledgeMint()
    await s.pauses.clear(reason, String(body.note ?? 'resumed from admin panel').slice(0, 300))
    s.worker.wake()
    return { ok: true, pauses: s.pauses.list() }
  })

  app.post('/api/admin/payout-rate', async (req, reply) => {
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

  app.post('/api/admin/payouts/:id/retry', async (req, reply) => {
    const raw = (req.params as { id: string }).id
    if (!/^\d+$/.test(raw)) return fail(reply, 400, 'bad_request', 'invalid id')
    const [p] = await db
      .update(payouts)
      .set({ status: 'queued', nextAttemptAt: null, error: null })
      .where(sql`${payouts.id} = ${BigInt(raw)} AND ${payouts.status} IN ('failed', 'failed_permanent')`)
      .returning()
    if (!p) return fail(reply, 409, 'not_retryable', 'only failed / failed_permanent payouts can be retried')
    s.worker.wake()
    return jsonSafe({ ok: true, payout: p })
  })

  app.post('/api/admin/wallets/:address/clear-handle', async (req) => {
    const address = (req.params as { address: string }).address
    await db.update(wallets).set({ xHandle: null }).where(eq(wallets.address, address))
    return { ok: true }
  })
}

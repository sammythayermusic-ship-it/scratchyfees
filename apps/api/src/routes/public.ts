import { desc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { entries, jackpot, payouts, rounds, tickets } from '../db/schema'
import type { Services } from '../services'
import { clientIp, fail, jsonSafe, KeyedLimiter } from './http'

/**
 * Read-only public endpoints (PLAN §3.2): /api/round, /api/winners, /api/fair/:roundId, /api/stats,
 * /api/payout/:id. Never exposes an unrevealed outcome of a live round.
 */

export async function roundSnapshot(s: Services, wallet?: string | null) {
  const db = s.database.db
  const [live] = await db
    .select()
    .from(rounds)
    .where(eq(rounds.status, 'live'))
    .orderBy(desc(rounds.id))
    .limit(1)
  const [latest] = live
    ? [live]
    : await db
        .select()
        .from(rounds)
        .where(sql`${rounds.status} IN ('live','skipped','ended')`)
        .orderBy(desc(rounds.id))
        .limit(1)
  const [next] = await db
    .select()
    .from(rounds)
    .where(eq(rounds.status, 'pending'))
    .orderBy(rounds.id)
    .limit(1)
  const [pot] = await db.select().from(jackpot).where(eq(jackpot.id, 1))
  const prices = s.oracle.peek()
  const mon = s.monitor.state()
  let you: { ticketsRemaining: number; entered: boolean } | null = null
  if (wallet && live) {
    const [row] = await db
      .execute<{ total: number; left: number }>(
        sql`
      SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE scratched_at IS NULL AND NOT void)::int AS left
      FROM tickets WHERE round_id = ${live.id} AND wallet = ${wallet}`,
      )
      .then((r) => r.rows)
    you = { entered: (row?.total ?? 0) > 0, ticketsRemaining: row?.left ?? 0 }
  }
  const hold = s.pauses.first() ?? (mon.lowGas ? 'low_gas' : mon.lowPool ? 'low_pool' : null)
  return {
    serverTime: new Date().toISOString(),
    roundSeconds: s.config.economy.roundSeconds,
    round: latest
      ? {
          id: latest.id,
          status: latest.status,
          startsAt: latest.startsAt.toISOString(),
          endsAt: latest.endsAt.toISOString(),
          seedHash: latest.serverSeedHash,
          skipReason: latest.skipReason,
          entrants: latest.entrantCount,
          tickets: latest.ticketCount,
          poolRaw: latest.poolRaw?.toString() ?? null,
          budgetRaw: latest.budgetRaw?.toString() ?? null,
          totalWeightedMicro: latest.totalWeightedMicro?.toString() ?? null,
        }
      : null,
    nextRound: next
      ? { id: next.id, startsAt: next.startsAt.toISOString(), seedHash: next.serverSeedHash }
      : null,
    pool: {
      /** live free pool P (monitor, ~30 s) — falls back to the round snapshot */
      raw: (mon.poolRaw ?? latest?.poolRaw ?? 0n).toString(),
      jackpotRaw: (pot?.amountRaw ?? 0n).toString(),
      decimals: 6,
    },
    prices: {
      pumpUsdE18: prices.pumpUsd?.valueE18.toString() ?? null,
      scratchyUsdE18: prices.scratchyUsd?.valueE18.toString() ?? null,
      state: prices.state,
      lastFreshAt: prices.lastFreshAt?.toISOString() ?? null,
    },
    paused: hold,
    cluster: s.config.env.CHAIN_MODE === 'memory' ? 'memory' : s.config.env.SOLANA_CLUSTER,
    you,
  }
}

export async function registerPublicRoutes(app: FastifyInstance, s: Services) {
  const db = s.database.db

  // public reads: per-IP limit + a short cache on the expensive aggregate queries (security review #6)
  const readLimit = new KeyedLimiter(240)
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'GET' || !req.url.startsWith('/api/') || req.url.startsWith('/api/admin')) return
    if (!readLimit.take(clientIp(req, s.config.env.TRUST_CLOUDFLARE)))
      return fail(reply, 429, 'rate_limited', 'slow down a little')
  })
  const CACHED = /^\/api\/(winners|stats)(\?|$)/
  const cache = new Map<string, { at: number; payload: string }>()
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'GET' || !CACHED.test(req.url)) return
    const hit = cache.get(req.url)
    if (hit && Date.now() - hit.at < 3_000)
      return reply.header('content-type', 'application/json; charset=utf-8').send(hit.payload)
  })
  app.addHook('onSend', async (req, reply, payload) => {
    if (
      req.method === 'GET' &&
      CACHED.test(req.url) &&
      reply.statusCode === 200 &&
      typeof payload === 'string'
    ) {
      if (cache.size > 500) cache.clear()
      if (!cache.has(req.url) || Date.now() - cache.get(req.url)!.at >= 3_000)
        cache.set(req.url, { at: Date.now(), payload })
    }
    return payload
  })

  app.get('/api/round', async (req) => {
    const q = req.query as { wallet?: string }
    return roundSnapshot(s, typeof q.wallet === 'string' ? q.wallet : null)
  })

  app.get('/api/winners', async (req) => {
    const q = req.query as { before?: string; limit?: string }
    const limit = Math.min(Math.max(Number(q.limit) || 30, 1), 100)
    const before = q.before && /^\d+$/.test(q.before) ? BigInt(q.before) : null
    const cols = sql`t.id, t.round_id, t.wallet, t.tier, t.prize_raw, t.jackpot_prize_raw, t.scratched_at,
      w.x_handle, p.tx_sig, p.status AS payout_status, p.pump_usd_e18, e.mult_micro`
    const from = sql`FROM tickets t
      LEFT JOIN wallets w ON w.address = t.wallet
      LEFT JOIN entries e ON e.round_id = t.round_id AND e.wallet = t.wallet
      LEFT JOIN payouts p ON p.id = COALESCE(t.jackpot_payout_id, t.payout_id)
      WHERE t.scratched_at IS NOT NULL AND (t.prize_raw > 0 OR t.jackpot_prize_raw > 0)`
    const recent = await db.execute(sql`SELECT ${cols} ${from} ${before ? sql`AND t.id < ${before}` : sql``}
      ORDER BY t.id DESC LIMIT ${limit}`)
    const biggest = await db.execute(sql`SELECT ${cols} ${from}
      ORDER BY (t.prize_raw + t.jackpot_prize_raw) DESC, t.id DESC LIMIT 12`)
    const shape = (r: Record<string, unknown>) => ({
      ticketId: String(r.id),
      roundId: Number(r.round_id),
      wallet: String(r.wallet),
      xHandle: (r.x_handle as string | null) ?? null,
      tier: Number(r.tier),
      multMicro: r.mult_micro ? String(r.mult_micro) : null,
      prizeRaw: String(r.prize_raw),
      jackpotPrizeRaw: String(r.jackpot_prize_raw),
      at: new Date(r.scratched_at as string).toISOString(),
      txSig: (r.tx_sig as string | null) ?? null,
      payoutStatus: (r.payout_status as string | null) ?? null,
      pumpUsdE18: (r.pump_usd_e18 as string | null) ?? null,
    })
    const rows = recent.rows.map(shape)
    return {
      recent: rows,
      biggest: biggest.rows.map(shape),
      nextBefore: rows.length === limit ? rows.at(-1)!.ticketId : null,
    }
  })

  app.get('/api/fair/:roundId', async (req, reply) => {
    const id = Number((req.params as { roundId: string }).roundId)
    if (!Number.isInteger(id) || id <= 0) return fail(reply, 400, 'bad_request', 'invalid round id')
    const [r] = await db.select().from(rounds).where(eq(rounds.id, id))
    if (!r) return fail(reply, 404, 'not_found', 'no such round')
    const revealed = r.status === 'ended' || r.status === 'skipped'
    const es = await db
      .select({
        wallet: entries.wallet,
        tickets: entries.tickets,
        multMicro: entries.multMicro,
        holdingsUsdMicro: entries.holdingsUsdMicro,
      })
      .from(entries)
      .where(eq(entries.roundId, id))
      .limit(5_000)
    return jsonSafe({
      round: {
        id: r.id,
        status: r.status,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        seedHash: r.serverSeedHash,
        serverSeed: revealed ? r.serverSeed : null,
        poolRaw: r.poolRaw,
        budgetRaw: r.budgetRaw,
        ticketBudgetRaw: r.ticketBudgetRaw,
        jackpotAccrualRaw: r.jackpotAccrualRaw,
        singlePrizeCapRaw: r.singlePrizeCapRaw,
        payoutRatePpm: r.payoutRatePpm,
        jackpotSharePpm: r.jackpotSharePpm,
        singlePrizeCapPpm: r.singlePrizeCapPpm,
        roundBreakerPpm: r.roundBreakerPpm,
        jackpotOdds: r.jackpotOdds,
        totalWeightedMicro: r.totalWeightedMicro,
        skipReason: r.skipReason,
      },
      entries: es,
      howToVerify: [
        'sha256(serverSeed) must equal seedHash (published before the round started).',
        'digest = HMAC_SHA256(key = serverSeed bytes, message = "<wallet>:<roundId>:<ticketIdx>")',
        'x = big-endian uint64 of digest[0..7] >> 11; tier = first row with x·1e6 < cumulative_ppm·2^53 (700000, 900000, 970000, 995000, 999000, 1000000)',
        'y = big-endian uint64 of digest[8..15] >> 11; jackpot hit iff y·JACKPOT_ODDS < 2^53',
        'prize = min(floor(k10 × ticketBudget × mult_µ / (10 × W_µ)), singlePrizeCap) with k10 = 0,15,50,80,250,500',
      ],
    })
  })

  /** After a round ends: a wallet's stored tickets, to compare with your own recomputation. */
  app.get('/api/fair/:roundId/tickets', async (req, reply) => {
    const id = Number((req.params as { roundId: string }).roundId)
    const wallet = (req.query as { wallet?: string }).wallet
    if (!Number.isInteger(id) || !wallet)
      return fail(reply, 400, 'bad_request', 'round id and wallet required')
    const [r] = await db.select().from(rounds).where(eq(rounds.id, id))
    if (!r) return fail(reply, 404, 'not_found', 'no such round')
    if (r.status !== 'ended')
      return fail(reply, 409, 'not_revealed', 'outcomes are published when the round ends')
    const ts = await db
      .select({
        idx: tickets.idx,
        tier: tickets.tier,
        jackpot: tickets.jackpot,
        prizeRaw: tickets.prizeRaw,
        scratched: tickets.scratchedAt,
        void: tickets.void,
      })
      .from(tickets)
      .where(sql`${tickets.roundId} = ${id} AND ${tickets.wallet} = ${wallet}`)
      .orderBy(tickets.idx)
    return jsonSafe({ roundId: id, wallet, tickets: ts })
  })

  app.get('/api/stats', async () => {
    const [totals] = (
      await db.execute<{ paid: string; count: number; biggest: string | null }>(sql`
        SELECT COALESCE(SUM(amount_raw), 0)::text AS paid, COUNT(*)::int AS count, MAX(amount_raw)::text AS biggest
        FROM payouts WHERE status = 'confirmed' AND kind IN ('tier', 'jackpot')`)
    ).rows
    const [sweepTotals] = (
      await db.execute<{ to_prize: string; to_ops: string }>(sql`
        SELECT COALESCE(SUM(to_prize_raw), 0)::text AS to_prize, COALESCE(SUM(to_ops_raw), 0)::text AS to_ops
        FROM sweeps WHERE status = 'done'`)
    ).rows
    const history = await db
      .select({
        id: rounds.id,
        startsAt: rounds.startsAt,
        status: rounds.status,
        poolRaw: rounds.poolRaw,
        jackpotRaw: rounds.jackpotAfterRaw,
        tickets: rounds.ticketCount,
      })
      .from(rounds)
      .where(sql`${rounds.status} IN ('live','ended','skipped')`)
      .orderBy(desc(rounds.id))
      .limit(144)
    return jsonSafe({
      totalPaidRaw: totals?.paid ?? '0',
      payoutCount: totals?.count ?? 0,
      biggestWinRaw: totals?.biggest ?? '0',
      sweptToPoolRaw: sweepTotals?.to_prize ?? '0',
      sweptToOpsRaw: sweepTotals?.to_ops ?? '0',
      poolHistory: history.reverse(),
    })
  })

  app.get('/api/payout/:id', async (req, reply) => {
    const raw = (req.params as { id: string }).id
    if (!/^\d+$/.test(raw)) return fail(reply, 400, 'bad_request', 'invalid payout id')
    const [p] = await db
      .select()
      .from(payouts)
      .where(eq(payouts.id, BigInt(raw)))
    if (!p || (p.kind !== 'tier' && p.kind !== 'jackpot'))
      return fail(reply, 404, 'not_found', 'no such payout')
    return jsonSafe({
      id: p.id,
      kind: p.kind,
      wallet: p.wallet,
      amountRaw: p.amountRaw,
      status: p.status,
      held: p.status === 'held',
      txSig: p.txSig,
      roundId: p.roundId,
      pumpUsdE18: p.pumpUsdE18,
      confirmedAt: p.confirmedAt,
    })
  })
}

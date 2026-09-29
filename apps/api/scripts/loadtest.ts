/**
 * Load test of the hot path (PLAN §8 Phase 5): POST /api/scratch under concurrency, against the real
 * Fastify app + Postgres + payout worker, on the in-memory chain (no RPC in the loop — this measures OUR
 * capacity, not a provider's). Rate limits are raised so the limiter doesn't cap the measurement.
 *
 *   pnpm --filter @scratchy/api loadtest [--wallets 400] [--connections 64] [--mode single|all]
 *
 * mode single: one request per ticket (the worst case: every ticket scratched by hand)
 * mode all:    one SCRATCH ALL request per wallet (≤ 100 tickets each)
 * After the run it checks every ticket was revealed exactly once and the payouts equal the revealed prizes.
 */
import autocannon from 'autocannon'
import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import pg from 'pg'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { buildApp } from '../src/app'
import { payouts, rounds, tickets } from '../src/db/schema'
import { loadConfig } from '../src/env'
import { buildServices, devAddress } from '../src/services'

const { values: args } = parseArgs({
  options: {
    wallets: { type: 'string', default: '400' },
    connections: { type: 'string', default: '64' },
    mode: { type: 'string', default: 'single' },
    port: { type: 'string', default: '4200' },
    database: { type: 'string', default: 'postgres://scratchy:scratchy@127.0.0.1:5433/scratchy_loadtest' },
  },
})
const WALLETS = Number(args.wallets)
const PORT = Number(args.port)

async function ensureDatabase(url: string): Promise<void> {
  const u = new URL(url)
  const name = u.pathname.slice(1).replace(/"/g, '')
  u.pathname = '/postgres'
  const c = new pg.Client({ connectionString: u.toString() })
  await c.connect()
  const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
  if (exists.rowCount === 0) await c.query(`CREATE DATABASE "${name}"`)
  await c.end()
}

async function main() {
  await ensureDatabase(args.database!)
  let clock = Date.parse('2026-09-29T12:00:05Z')
  const now = () => new Date(clock)
  const cfg = loadConfig({
    NODE_ENV: 'development',
    CHAIN_MODE: 'memory',
    DATABASE_URL: args.database!,
    ENGINE_ENABLED: 'false',
    SWEEPER_ENABLED: 'false',
    ROUND_SECONDS: '600',
    RATE_LIMIT_ENTER_PER_MIN: '1000000',
    RATE_LIMIT_SCRATCH_PER_MIN: '1000000',
    RATE_LIMIT_WALLET_PER_MIN: '1000000',
    MAX_WALLETS_PER_IP_PER_ROUND: '1000000',
    PORT: String(PORT),
  })
  const s = await buildServices(cfg, { now }) // memory mode: fresh database
  const app = await buildApp(s)
  await app.listen({ port: PORT, host: '127.0.0.1' })
  await s.oracle.get()
  s.start()

  // round N: every wallet shows up (Decision C) → round N+1 drops their tickets
  await s.engine.tick()
  const players = Array.from({ length: WALLETS }, (_, i) => ({
    wallet: devAddress(`load-${i}`),
    session: randomBytes(18).toString('base64url'),
  }))
  for (const p of players) {
    const r = await s.entries.enter({
      wallet: p.wallet,
      sessionId: p.session,
      ip: `10.0.${(players.indexOf(p) >> 8) & 255}.${players.indexOf(p) & 255}`,
    })
    if ('error' in r) throw new Error(r.message)
  }
  clock += 600_000
  await s.engine.tick()
  const [live] = await s.database.db.select().from(rounds).where(eq(rounds.status, 'live'))
  for (const p of players) await s.entries.enter({ wallet: p.wallet, sessionId: p.session, ip: '127.0.0.1' })
  const all = await s.database.db
    .select({ id: tickets.id, wallet: tickets.wallet })
    .from(tickets)
    .where(eq(tickets.roundId, live!.id))
  const session = new Map(players.map((p) => [p.wallet, p.session]))
  console.log(
    `round ${live!.id}: ${players.length} wallets, ${all.length} tickets, W=${live!.totalWeightedMicro}`,
  )

  const bodies =
    args.mode === 'all'
      ? players.map((p) => ({
          wallet: p.wallet,
          ids: all.filter((t) => t.wallet === p.wallet).map((t) => t.id.toString()),
        }))
      : all.map((t) => ({ wallet: t.wallet, ids: [t.id.toString()] }))
  let next = 0
  const lag = monitorEventLoopDelay({ resolution: 10 })
  lag.enable()
  const result = await autocannon({
    url: `http://127.0.0.1:${PORT}`,
    connections: Number(args.connections),
    amount: bodies.length,
    requests: [
      {
        method: 'POST',
        path: '/api/scratch',
        setupRequest: (req) => {
          const b = bodies[next++ % bodies.length]!
          return {
            ...req,
            headers: { 'content-type': 'application/json', 'x-scratchy-session': session.get(b.wallet)! },
            body: JSON.stringify({ wallet: b.wallet, ticket_ids: b.ids }),
          }
        },
      },
    ],
  })
  lag.disable()

  // let the payout worker drain, then check exactly-once
  const drainUntil = Date.now() + 120_000
  for (;;) {
    const [{ open }] = (
      await s.database.db.execute<{ open: number }>(
        sql`SELECT COUNT(*)::int AS open FROM payouts WHERE status IN ('queued','sending')`,
      )
    ).rows as [{ open: number }]
    if (open === 0 || Date.now() > drainUntil) break
    await new Promise((r) => setTimeout(r, 500))
  }
  const scratched = await s.database.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.roundId, live!.id), isNotNull(tickets.scratchedAt)))
  const prizes = scratched.reduce((t, x) => t + x.prizeRaw, 0n)
  const paid = (await s.database.db.select().from(payouts).where(eq(payouts.kind, 'tier'))).reduce(
    (t, p) => t + p.amountRaw,
    0n,
  )
  const [{ confirmed }] = (
    await s.database.db.execute<{ confirmed: number }>(
      sql`SELECT COUNT(*)::int AS confirmed FROM payouts WHERE status = 'confirmed'`,
    )
  ).rows as [{ confirmed: number }]

  const summary = {
    mode: args.mode,
    wallets: players.length,
    tickets: all.length,
    requests: result.requests.total,
    non2xx: result.non2xx,
    errors: result.errors,
    timeouts: result.timeouts,
    reqPerSec: result.requests.average,
    latencyMs: {
      p50: result.latency.p50,
      p90: result.latency.p90,
      p99: result.latency.p99,
      max: result.latency.max,
    },
    eventLoopLagMs: { p50: lag.percentile(50) / 1e6, p99: lag.percentile(99) / 1e6, max: lag.max / 1e6 },
    ticketsRevealed: scratched.length,
    revealedExactlyOnce: scratched.length === all.length,
    payoutsEqualPrizes: paid === prizes,
    payoutsConfirmed: confirmed,
  }
  console.log(JSON.stringify(summary, null, 2))
  await app.close()
  await s.stop()
  process.exit(
    summary.non2xx === 0 && summary.errors === 0 && summary.revealedExactlyOnce && summary.payoutsEqualPrizes
      ? 0
      : 1,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

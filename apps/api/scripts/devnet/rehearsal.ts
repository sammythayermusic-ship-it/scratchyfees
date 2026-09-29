/**
 * Phase 5 DEVNET DRESS REHEARSAL (PLAN §8): a day's worth of rounds (144), accelerated, on the real devnet
 * cluster with the real Solana client, the real DAMM v2 pool and real transfers:
 *   - the full API runs in-process on a fresh database (engine + worker + sweeper + monitor + reconciler)
 *   - three rehearsal wallets (~$60 / ~$600 / ~$5,000 of mock-SCRATCHY) play every round over HTTP exactly like
 *     the site: POST /api/enter (Decision C activity) then POST /api/scratch with every ticket (SCRATCH ALL)
 *   - TRADER swaps on the main pool every few rounds → real 3% fees → the sweeper claims and splits 70/30
 *   - one forced jackpot (devnet-only seed grinding for TEST2's ticket 0 in round --jackpot-at) and one forced
 *     breaker trip (round --breaker-at runs with a 1-ppm breaker → hold → round-end re-derivation → release)
 * Then it verifies everything from the chain and the database:
 *   - every payout on-chain: memo `scratchy:<DEPLOY_ID>:<id>`, recipient, exact amount, one landed tx each
 *   - every PRIZE-wallet PUMP movement since the start maps to exactly one payout or sweep transfer
 *   - chain → ledger reconciliation (exact), every revealed ticket re-derived from the revealed seed,
 *     J(n) = J(n−1) + accrual − paid, ≤ 1 jackpot per round, scratched xor void, sweep splits exact
 * and writes .devnet/rehearsal-report.json. DEVNET ONLY (genesis-gated). Needs `pnpm devnet:setup` first.
 *
 *   pnpm --filter @scratchy/api devnet:rehearsal [--rounds 144] [--round-seconds 25]
 *        [--jackpot-at 40] [--breaker-at 90] [--inflow-every 10] [--port 4100]
 */
import { recomputeTicket, seedMatchesCommitment } from '@scratchy/core'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Connection, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { asc } from 'drizzle-orm'
import pg from 'pg'
import { buildApp } from '../../src/app'
import { payoutMemo } from '../../src/chain/types'
import {
  entries,
  jackpot,
  payoutAttempts,
  payouts,
  prizeLedger,
  rounds,
  sweeps,
  tickets,
} from '../../src/db/schema'
import { roundParams } from '../../src/engine/rounds'
import { loadConfig, type AppConfig } from '../../src/env'
import { buildServices, type Services } from '../../src/services'
import { DEVNET_DIR, envFilePath, sleep } from './lib'

// ── cli ──────────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    rounds: { type: 'string', default: '144' },
    'round-seconds': { type: 'string', default: '25' },
    'jackpot-at': { type: 'string', default: '40' },
    'breaker-at': { type: 'string', default: '90' },
    'inflow-every': { type: 'string', default: '10' },
    port: { type: 'string', default: '4100' },
    database: { type: 'string', default: 'postgres://scratchy:scratchy@127.0.0.1:5433/scratchy_rehearsal' },
  },
})
const ROUNDS = Number(args.rounds)
const ROUND_SECONDS = Number(args['round-seconds'])
const JACKPOT_AT = Number(args['jackpot-at'])
const BREAKER_AT = Number(args['breaker-at'])
const INFLOW_EVERY = Number(args['inflow-every'])
const PORT = Number(args.port)
const BASE = `http://127.0.0.1:${PORT}`

interface Check {
  name: string
  ok: boolean
  detail: string
}
const checks: Check[] = []
function check(name: string, ok: boolean, detail = ''): boolean {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}
/** the public devnet RPC rate-limits hard: retry transient failures with backoff (verification is read-only) */
async function rpc<T>(fn: () => Promise<T>, what = 'rpc'): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const msg = (e as Error).message ?? ''
      if (
        i >= 12 ||
        !/429|Too Many|Transient|timeout|ECONNRESET|fetch failed|503|502/i.test(`${(e as Error).name} ${msg}`)
      )
        throw e
      await sleep(Math.min(1_000 * 2 ** Math.min(i, 3), 8_000))
    }
  }
  void what
}
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`)

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    out[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '')
  }
  return out
}

/** drop + recreate the rehearsal database: the ledger must describe only this run */
async function freshDatabase(url: string): Promise<void> {
  const u = new URL(url)
  const name = u.pathname.slice(1).replace(/"/g, '')
  if (!/rehearsal/.test(name))
    throw new Error(`refusing to drop ${name}: the rehearsal database name must contain "rehearsal"`)
  u.pathname = '/postgres'
  const c = new pg.Client({ connectionString: u.toString() })
  await c.connect()
  await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await c.query(`CREATE DATABASE "${name}"`)
  await c.end()
}

// ── the player bot (talks HTTP, exactly like the site) ───────────────────────
interface Player {
  label: string
  wallet: string
  session: string
}
interface EnterRes {
  round: { id: number } | null
  entry: { tickets: { id: string; scratched: boolean; void: boolean }[] } | null
  locked: boolean
}
interface ScratchRes {
  ok: true
  outcomes: {
    ticketId: string
    tier: number
    prizeRaw: string
    jackpotPrizeRaw: string
    payoutId: string | null
  }[]
}

async function post<T>(path: string, session: string, body: unknown): Promise<{ status: number; json: T }> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-scratchy-session': session },
    body: JSON.stringify(body),
  })
  return { status: r.status, json: (await r.json()) as T }
}

const stats = {
  enters: 0,
  scratchCalls: 0,
  retries: 0,
  ticketsScratched: 0,
  wins: 0,
  jackpots: 0,
  errors: [] as string[],
}

async function postRetry<T>(path: string, session: string, body: unknown) {
  for (let i = 0; ; i++) {
    const r = await post<T>(path, session, body)
    if ((r.status !== 503 && r.status !== 429) || i >= 5) return r
    stats.retries++
    await sleep(2_000 * (i + 1))
  }
}

async function play(p: Player): Promise<void> {
  const e = await postRetry<EnterRes>('/api/enter', p.session, { wallet: p.wallet })
  stats.enters++
  if (e.status !== 200) {
    stats.errors.push(`${p.label} enter ${e.status}: ${JSON.stringify(e.json).slice(0, 160)}`)
    return
  }
  const fresh = (e.json.entry?.tickets ?? []).filter((t) => !t.scratched && !t.void).map((t) => t.id)
  if (!fresh.length) return
  const s = await postRetry<ScratchRes | { error: string; message: string }>('/api/scratch', p.session, {
    wallet: p.wallet,
    ticket_ids: fresh,
  })
  stats.scratchCalls++
  if (s.status !== 200 || !('ok' in s.json)) {
    stats.errors.push(`${p.label} scratch ${s.status}: ${JSON.stringify(s.json).slice(0, 160)}`)
    return
  }
  stats.ticketsScratched += s.json.outcomes.length
  stats.wins += s.json.outcomes.filter((o) => o.tier > 0).length
  stats.jackpots += s.json.outcomes.filter((o) => BigInt(o.jackpotPrizeRaw) > 0n).length
}

function feeInflow(): void {
  const child = spawn(
    'pnpm',
    ['exec', 'tsx', 'scripts/devnet/fee-inflow.ts', '--pool', 'main', '--count', '4', '--interval', '2'],
    {
      cwd: resolve(import.meta.dirname, '../..'),
      stdio: 'ignore',
    },
  )
  child.on('error', (err) => stats.errors.push(`fee inflow: ${err.message}`))
}

// ── run ──────────────────────────────────────────────────────────────────────
async function main() {
  const envPath = envFilePath('devnet')
  if (!existsSync(envPath)) throw new Error(`${envPath} not found — run pnpm devnet:setup first`)
  const devnetEnv = parseEnvFile(envPath)
  const players: Player[] = (['TEST1', 'TEST2', 'TEST3'] as const).map((k) => {
    const wallet = devnetEnv[`${k}_WALLET_ADDRESS`]
    if (!wallet) throw new Error(`${k}_WALLET_ADDRESS missing from .env.devnet`)
    return { label: k, wallet, session: randomBytes(18).toString('base64url') }
  })
  await freshDatabase(args.database!)
  const input: Record<string, string> = {
    ...devnetEnv,
    DATABASE_URL: args.database!,
    NODE_ENV: 'development',
    PORT: String(PORT),
    ROUND_SECONDS: String(ROUND_SECONDS),
    ENGINE_ENABLED: 'true',
    SWEEPER_ENABLED: 'true',
    SWEEP_INTERVAL_MIN: '2',
    SWAP: 'none',
    CORS_ORIGINS: 'http://localhost:3000',
    DEV_FORCE_JACKPOT: 'true',
    DEV_FORCE_JACKPOT_WALLET: players[1]!.wallet,
    DEV_FORCE_JACKPOT_ROUND: String(JACKPOT_AT),
    DEV_FORCE_BREAKER_ROUND: String(BREAKER_AT),
  }
  const config: AppConfig = loadConfig(input)
  if (config.env.SOLANA_CLUSTER !== 'devnet' && config.env.SOLANA_CLUSTER !== 'localnet')
    throw new Error('devnet only')

  log(`booting the API on ${BASE} (fresh database, ${ROUND_SECONDS}s rounds × ${ROUNDS})`)
  const s = await buildServices(config) // verifies the cluster by genesis hash before anything else
  const app = await buildApp(s)
  await app.listen({ port: PORT, host: '127.0.0.1' })
  const startSlot = await rpc(() => s.chain.getSlot('finalized'))
  const solBefore = {
    prize: (await rpc(() => s.chain.getSolBalance(s.prizeAddress))).value,
    creator: (await rpc(() => s.chain.getSolBalance(s.creatorAddress!))).value,
  }
  s.start()

  // ── play until round ROUNDS has ended ──
  const t0 = Date.now()
  let lastRound = 0
  let lastInflow = 0
  for (;;) {
    const r = (await (await fetch(`${BASE}/api/round`)).json()) as {
      round: { id: number; status: string } | null
    }
    const id = r.round?.id ?? 0
    if (id > ROUNDS) break
    if (id !== lastRound) {
      lastRound = id
      await sleep(1_500) // let the drop settle
      await Promise.all(
        players.map((p) =>
          play(p).catch((e) => void stats.errors.push(`${p.label}: ${(e as Error).message}`)),
        ),
      )
      if (id - lastInflow >= INFLOW_EVERY) {
        lastInflow = id
        feeInflow()
      }
      if (id % 10 === 0 || id <= 2) {
        log(
          `round ${id}/${ROUNDS}: ${stats.ticketsScratched} tickets scratched, ${stats.wins} wins, ${stats.jackpots} jackpots, ${stats.errors.length} bot errors`,
        )
      }
    }
    await sleep(1_000)
    if (Date.now() - t0 > (ROUNDS + 10) * ROUND_SECONDS * 1_000 * 2)
      throw new Error('rehearsal overran its time budget')
  }
  log(`round ${ROUNDS} ended — letting payouts and the last sweep settle`)
  const settleUntil = Date.now() + 5 * 60_000
  for (;;) {
    const open = (await s.database.db.select({ status: payouts.status }).from(payouts)).filter((p) =>
      ['queued', 'sending', 'held', 'failed'].includes(p.status),
    ).length
    if (open === 0 || Date.now() > settleUntil) break
    await sleep(3_000)
  }
  await app.close()
  await s.stop() // engine, sweeper, worker, monitor, reconciler all stop; the DB closes

  // ── verification (read-only services on the same DB) ──
  log('verifying against the chain and the database')
  const v = await buildServices(loadConfig({ ...input, ENGINE_ENABLED: 'false', SWEEPER_ENABLED: 'false' }), {
    migrate: false,
  })
  try {
    await verify(v, players, startSlot, solBefore)
  } finally {
    await v.stop()
  }

  const passed = checks.filter((c) => c.ok).length
  const report = {
    at: new Date().toISOString(),
    rounds: ROUNDS,
    roundSeconds: ROUND_SECONDS,
    jackpotAt: JACKPOT_AT,
    breakerAt: BREAKER_AT,
    durationMin: Math.round((Date.now() - t0) / 60_000),
    bot: stats,
    passed,
    total: checks.length,
    checks,
  }
  const out = resolve(DEVNET_DIR, 'rehearsal-report.json')
  writeFileSync(
    out,
    JSON.stringify(report, (_k, val) => (typeof val === 'bigint' ? val.toString() : val), 2),
  )
  console.log(`\n${passed}/${checks.length} checks passed — report: ${out}`)
  process.exit(passed === checks.length ? 0 : 1)
}

async function verify(
  s: Services,
  players: Player[],
  startSlot: number,
  solBefore: { prize: bigint; creator: bigint },
) {
  const db = s.database.db
  const deployId = s.config.env.DEPLOY_ID
  const allRounds = await db.select().from(rounds).orderBy(asc(rounds.id))
  const allPayouts = await db.select().from(payouts).orderBy(asc(payouts.id))
  const allAttempts = await db.select().from(payoutAttempts)
  const allTickets = await db.select().from(tickets)
  const allEntries = await db.select().from(entries)
  const ledger = await db.select().from(prizeLedger)

  // 1. rounds happened
  const ended = allRounds.filter((r) => r.status === 'ended' || r.status === 'skipped')
  check(
    'rounds: a day of rounds ran',
    ended.length >= ROUNDS,
    `${ended.length} ended/skipped (${allRounds.filter((r) => r.status === 'skipped').length} skipped)`,
  )
  check(
    'bot: every enter/scratch call succeeded',
    stats.errors.length === 0,
    stats.errors.slice(0, 5).join(' · ') || `${stats.enters} enters, ${stats.scratchCalls} scratch calls`,
  )

  // 2. every payout settled and verified on-chain
  const byStatus = new Map<string, number>()
  for (const p of allPayouts) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1)
  check(
    'payouts: all confirmed',
    allPayouts.every((p) => p.status === 'confirmed'),
    JSON.stringify(Object.fromEntries(byStatus)),
  )
  let verified = 0
  const bad: string[] = []
  for (const p of allPayouts.filter((x) => x.status === 'confirmed')) {
    const signer = p.signer === 'creator' ? s.creatorAddress! : s.prizeAddress
    const tx = await rpc(() => s.chain.getPayoutTx(p.txSig!, s.pumpMint, signer))
    await sleep(120)
    const ok =
      !!tx &&
      tx.err === null &&
      !!tx.memo?.includes(payoutMemo(deployId, p.id)) &&
      tx.recipientOwner === p.wallet &&
      tx.recipientDeltaRaw === p.amountRaw &&
      tx.senderDeltaRaw === -p.amountRaw
    if (ok) verified++
    else
      bad.push(
        `#${p.id} ${p.txSig?.slice(0, 10)} memo=${tx?.memo} to=${tx?.recipientOwner} +${tx?.recipientDeltaRaw}/${tx?.senderDeltaRaw}`,
      )
  }
  check(
    'payouts: every one verified on-chain (memo ↔ row, recipient, exact amount)',
    bad.length === 0,
    bad.slice(0, 3).join(' · ') || `${verified} transfers`,
  )
  const landedPer = new Map<string, number>()
  for (const a of allAttempts)
    if (a.status === 'landed' || a.status === 'landed_duplicate')
      landedPer.set(String(a.payoutId), (landedPer.get(String(a.payoutId)) ?? 0) + 1)
  check(
    'payouts: exactly one landed transaction per payout',
    [...landedPer.values()].every((n) => n === 1) && landedPer.size === byStatus.get('confirmed'),
    `${allAttempts.length} attempts for ${allPayouts.length} payouts`,
  )

  // 3. every PRIZE PUMP movement since the start is a known payout / sweep transfer
  const conn = new Connection(s.config.env.RPC_URL, 'confirmed')
  {
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(s.pumpMint),
      new PublicKey(s.prizeAddress),
      false,
      TOKEN_2022_PROGRAM_ID,
    )
    const sigs: string[] = []
    let before: string | undefined
    for (;;) {
      const page = await rpc(() => conn.getSignaturesForAddress(ata, { before, limit: 1000 }, 'finalized'))
      const mine = page.filter((x) => x.slot >= startSlot && !x.err)
      sigs.push(...mine.map((x) => x.signature))
      if (page.length < 1000 || page.some((x) => x.slot < startSlot)) break
      before = page.at(-1)!.signature
    }
    const known = new Map(allPayouts.filter((p) => p.txSig).map((p) => [p.txSig!, p]))
    const unknown: string[] = []
    for (const sig of sigs) {
      const p = known.get(sig)
      const d = await rpc(() => s.chain.getOwnerTokenDeltas(sig, s.prizeAddress))
      await sleep(120)
      const delta = d?.deltas.get(s.pumpMint) ?? 0n
      if (!p) {
        if (delta !== 0n) unknown.push(`${sig.slice(0, 10)} Δ${delta}`)
        continue
      }
      const expected = p.signer === 'prize' ? -p.amountRaw : p.kind === 'sweep_prize' ? p.amountRaw : 0n
      if (delta !== expected) unknown.push(`${sig.slice(0, 10)} Δ${delta} ≠ ${expected}`)
    }
    check(
      'PRIZE wallet: every PUMP movement maps to exactly one payout / sweep',
      unknown.length === 0,
      unknown.slice(0, 3).join(' · ') || `${sigs.length} transactions since slot ${startSlot}`,
    )
  }

  // 4. chain → ledger
  const chainBal = (await rpc(() => s.chain.getAtaBalance(s.prizeAddress, s.pumpMint, 'finalized'))).value
  const ledgerBal = ledger.reduce((t, l) => t + l.amountRaw, 0n)
  check(
    'ledger: finalized PRIZE balance == ledger exactly',
    chainBal === ledgerBal,
    `chain ${chainBal} · ledger ${ledgerBal} · diff ${chainBal - ledgerBal}`,
  )
  check(
    'ledger: no unexplained inflow or outflow booked',
    !ledger.some((l) => l.kind === 'external_in' || l.kind === 'external_out'),
    ledger
      .map((l) => l.kind)
      .filter((k, i, a) => a.indexOf(k) === i)
      .join(', '),
  )

  // 5. every revealed ticket re-derives; round-level invariants
  const multOf = new Map(allEntries.map((e) => [`${e.roundId}:${e.wallet}`, e.multMicro]))
  const mismatches: string[] = []
  let recomputed = 0
  let jackpotRounds = 0
  let prev: (typeof allRounds)[number] | null = null
  const jErrors: string[] = []
  for (const r of allRounds.filter((x) => x.jackpotAfterRaw !== null)) {
    // J(n) = J(n−1) − jackpot paid during round n−1 + accrual(n)
    if (prev) {
      const paid = allPayouts
        .filter((p) => p.kind === 'jackpot' && p.roundId === prev!.id)
        .reduce((t, p) => t + p.amountRaw, 0n)
      const expect = prev.jackpotAfterRaw! - paid + (r.jackpotAccrualRaw ?? 0n)
      if (expect !== r.jackpotAfterRaw) jErrors.push(`round ${r.id}: J ${r.jackpotAfterRaw} ≠ ${expect}`)
    }
    prev = r
    if (r.status !== 'ended') continue
    if (!r.serverSeed || !seedMatchesCommitment(r.serverSeed, r.serverSeedHash))
      mismatches.push(`round ${r.id}: seed ≠ commitment`)
    const params = roundParams(r)
    const ts = allTickets.filter((t) => t.roundId === r.id)
    for (const t of ts) {
      if (!t.scratchedAt === !t.void)
        mismatches.push(`ticket ${t.id}: scratched=${!!t.scratchedAt} void=${t.void}`)
      if (!t.scratchedAt || !r.serverSeed) continue
      const rc = recomputeTicket(
        r.serverSeed,
        t.wallet,
        t.idx,
        multOf.get(`${r.id}:${t.wallet}`) ?? 0n,
        params,
      )
      recomputed++
      if (rc.tier !== t.tier || rc.jackpot !== t.jackpot || rc.prizeRaw !== t.prizeRaw)
        mismatches.push(`ticket ${t.id} (round ${r.id} idx ${t.idx})`)
    }
    const roundTier = allPayouts
      .filter((p) => p.roundId === r.id && p.kind === 'tier')
      .reduce((t, p) => t + p.amountRaw, 0n)
    if (roundTier !== r.realizedRaw)
      mismatches.push(`round ${r.id}: tier payouts ${roundTier} ≠ realized ${r.realizedRaw}`)
    const jps = allPayouts.filter((p) => p.roundId === r.id && p.kind === 'jackpot' && p.amountRaw > 0n)
    if (jps.length > 1) mismatches.push(`round ${r.id}: ${jps.length} jackpot payouts`)
    if (jps.length) jackpotRounds++
  }
  check(
    'fairness: every revealed ticket re-derives from the revealed seed; scratched xor void',
    mismatches.length === 0,
    mismatches.slice(0, 3).join(' · ') || `${recomputed} tickets`,
  )
  check(
    'jackpot: J(n) = J(n−1) + accrual − paid for every round',
    jErrors.length === 0,
    jErrors.slice(0, 3).join(' · ') || `${allRounds.length} rounds`,
  )
  const [pot] = await db.select().from(jackpot)
  const lastPaid = allPayouts
    .filter((p) => p.kind === 'jackpot' && p.roundId === prev?.id)
    .reduce((t, p) => t + p.amountRaw, 0n)
  check(
    'jackpot: the pot row equals the last round J minus what it paid',
    !!pot && !!prev && pot.amountRaw === prev.jackpotAfterRaw! - lastPaid,
    `pot ${pot?.amountRaw}`,
  )

  // 6. the forced jackpot
  const jr = allRounds.find((r) => r.id === JACKPOT_AT)
  const jt = allTickets.find(
    (t) => t.roundId === JACKPOT_AT && t.wallet === players[1]!.wallet && t.idx === 0,
  )
  const jp = allPayouts.find(
    (p) => p.roundId === JACKPOT_AT && p.kind === 'jackpot' && p.wallet === players[1]!.wallet,
  )
  check(
    'forced jackpot: TEST2 ticket 0 hit and the whole pot was paid on-chain',
    !!jr && !!jt?.jackpot && !!jp && jp.status === 'confirmed' && jp.amountRaw > 0n,
    `round ${JACKPOT_AT}: ${jp ? `${jp.amountRaw} raw PUMP, ${jp.status}` : 'no jackpot payout'} (${jackpotRounds} jackpot round(s) total)`,
  )

  // 7. the forced breaker drill
  const br = allRounds.find((r) => r.id === BREAKER_AT)
  const brPayouts = allPayouts.filter((p) => p.roundId === BREAKER_AT && p.kind === 'tier')
  check(
    'breaker drill: tripped → held → round-end re-derivation OK → released → paid',
    !!br &&
      br.breakerTripped &&
      br.breakerVerified === 'ok' &&
      brPayouts.length > 0 &&
      brPayouts.every((p) => p.status === 'confirmed'),
    `round ${BREAKER_AT}: tripped=${br?.breakerTripped} verified=${br?.breakerVerified} payouts=${brPayouts.length}`,
  )
  check(
    'breaker: no other round tripped with a mismatch',
    !allRounds.some((r) => r.breakerVerified === 'mismatch'),
    `${allRounds.filter((r) => r.breakerTripped).length} trip(s)`,
  )

  // 8. sweeps
  const allSweeps = await db.select().from(sweeps)
  const sweepBad = allSweeps
    .filter((x) => x.status !== 'done' && x.status !== 'failed')
    .map((x) => `#${x.id} ${x.status}`)
  const splitBad = allSweeps
    .filter((x) => x.status === 'done')
    .filter((x) => x.toPrizeRaw + x.toOpsRaw !== x.claimedPumpRaw + x.swapOutPumpRaw)
    .map((x) => `#${x.id}`)
  check(
    'sweeps: every claim finished and split exactly 70/30',
    allSweeps.length > 0 && sweepBad.length === 0 && splitBad.length === 0,
    `${allSweeps.filter((x) => x.status === 'done').length} done, claimed ${allSweeps.reduce((t, x) => t + x.claimedPumpRaw, 0n)} raw PUMP${sweepBad.length ? ` · open ${sweepBad.join(',')}` : ''}${splitBad.length ? ` · bad split ${splitBad.join(',')}` : ''}`,
  )

  // 9. latency + costs (reported, not gated)
  const lat = allPayouts
    .filter((p) => p.signer === 'prize' && p.confirmedAt && p.createdAt && p.roundId !== BREAKER_AT)
    .map((p) => p.confirmedAt!.getTime() - p.createdAt.getTime())
    .sort((a, b) => a - b)
  const pct = (q: number) =>
    lat.length ? (lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]! / 1000).toFixed(1) : 'n/a'
  check(
    'latency: scratch → confirmed on devnet (p50 / p95 / max)',
    lat.length > 0,
    `${pct(0.5)}s / ${pct(0.95)}s / ${lat.length ? (lat.at(-1)! / 1000).toFixed(1) : 'n/a'}s over ${lat.length} payouts`,
  )
  const solAfter = {
    prize: (await rpc(() => s.chain.getSolBalance(s.prizeAddress))).value,
    creator: (await rpc(() => s.chain.getSolBalance(s.creatorAddress!))).value,
  }
  check(
    'gas: SOL spent (fees + ATA rent)',
    true,
    `PRIZE ${Number(solBefore.prize - solAfter.prize) / 1e9} SOL · CREATOR ${Number(solBefore.creator - solAfter.creator) / 1e9} SOL`,
  )
}

main().catch((e) => {
  console.error(`rehearsal failed: ${(e as Error).stack ?? e}`)
  process.exit(1)
})

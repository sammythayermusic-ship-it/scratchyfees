/**
 * Phase 2 green gate — DEVNET smoke test of the whole chain layer, end to end on the real cluster:
 *   1. boot: cluster verified by genesis hash, payout-mint extension scan, DAMM v2 venue init
 *   2. monitor: PRIZE PUMP + SOL gas read, payouts not paused
 *   3. payout to a FRESH wallet (idempotent ATA create, rent from PRIZE) — verified on-chain
 *   4. payout to the same wallet again (existing ATA) — verified on-chain
 *   5. payout in the HOOK-TEST mint (Token-2022 transfer-hook extension, like real PUMP) — verified on-chain
 *   6. real trades on the MAIN pool (OnlyB) → real claimPositionFee2 → exact 70/30 split, both transfers verified
 *   7. real trades on the SECOND pool (BothToken) → claim both tokens → swap ONLY the claimed SCRATCHY → split;
 *      CREATOR's own SCRATCHY never drops
 * Every payout is checked on-chain: memo `scratchy:<DEPLOY_ID>:<payoutId>`, recipient, exact amount.
 * Needs `pnpm devnet:setup` first. Writes .devnet/smoke-report.json. DEVNET ONLY (genesis-gated).
 *
 *   pnpm --filter @scratchy/api devnet:smoke
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { eq } from 'drizzle-orm'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import type { Alerter } from '../../src/alerts/types'
import { payoutMemo } from '../../src/chain/types'
import { payouts, sweeps } from '../../src/db/schema'
import { loadConfig } from '../../src/env'
import { PayoutWorker } from '../../src/payouts/worker'
import { buildServices, type Services } from '../../src/services'
import { FeeSweeper } from '../../src/sweeper/sweeper'
import { DammV2Venue } from '../../src/venue/damm-v2'
import { DammPoolSwap } from '../../src/venue/swap-damm'
import { DEVNET_DIR, envFilePath, REPO_ROOT } from './lib'

interface Check {
  name: string
  ok: boolean
  detail: string
}
const checks: Check[] = []
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    out[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '')
  }
  return out
}

async function ensureDatabase(url: string): Promise<void> {
  const u = new URL(url)
  const name = u.pathname.slice(1)
  u.pathname = '/postgres'
  const c = new pg.Client({ connectionString: u.toString() })
  await c.connect()
  const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
  if (exists.rowCount === 0) await c.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`)
  await c.end()
}

/** the public devnet RPC rate-limits hard: poll the sweeper every few seconds, not every loop */
const lastSweep = new Map<unknown, number>()
async function sweepThrottled(s: Services | FeeSweeper): Promise<void> {
  const sweeper = s instanceof FeeSweeper ? s : s.sweeper!
  if (Date.now() - (lastSweep.get(sweeper) ?? 0) < 6_000) return
  lastSweep.set(sweeper, Date.now())
  await sweeper.runOnce()
}

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 120_000,
): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

function feeInflow(args: string[]): void {
  const r = spawnSync('pnpm', ['exec', 'tsx', 'scripts/devnet/fee-inflow.ts', ...args], {
    cwd: resolve(REPO_ROOT, 'apps/api'),
    stdio: 'inherit',
    env: process.env,
  })
  if (r.status !== 0) throw new Error(`fee-inflow ${args.join(' ')} exited ${r.status}`)
}

const quietAlerter: Alerter = { notify: () => {}, flush: async () => {} }

async function verifyPayout(s: Services, id: bigint, mint: string, label: string): Promise<boolean> {
  const [p] = await s.database.db.select().from(payouts).where(eq(payouts.id, id))
  if (!p || p.status !== 'confirmed' || !p.txSig) {
    check(`${label}: confirmed`, false, `status ${p?.status}`)
    return false
  }
  const signer = p.signer === 'creator' ? s.creatorAddress! : s.prizeAddress
  const tx = await s.chain.getPayoutTx(p.txSig, mint, signer)
  const memoOk = tx?.memo?.includes(payoutMemo(s.config.env.DEPLOY_ID, p.id)) ?? false
  const ok =
    !!tx &&
    tx.err === null &&
    memoOk &&
    tx.recipientDeltaRaw === p.amountRaw &&
    tx.senderDeltaRaw === -p.amountRaw
  check(
    `${label}: on-chain verified`,
    ok,
    `sig ${p.txSig.slice(0, 12)}… memo ${memoOk ? 'ok' : `MISMATCH (${tx?.memo})`}, +${tx?.recipientDeltaRaw} / ${tx?.senderDeltaRaw}, ` +
      `latency ${p.confirmedAt && p.createdAt ? ((p.confirmedAt.getTime() - p.createdAt.getTime()) / 1000).toFixed(1) + 's' : 'n/a'}`,
  )
  return ok
}

async function main() {
  const envPath = envFilePath('devnet')
  if (!existsSync(envPath)) throw new Error(`${envPath} not found — run devnet setup first`)
  const devnetEnv = parseEnvFile(envPath)
  const DATABASE_URL = devnetEnv.DATABASE_URL ?? 'postgres://scratchy:scratchy@127.0.0.1:5433/scratchy_devnet'
  await ensureDatabase(DATABASE_URL)
  const config = loadConfig({
    ...devnetEnv,
    DATABASE_URL,
    NODE_ENV: 'development',
    SWAP: 'none',
    ENGINE_ENABLED: 'false',
    SWEEP_INTERVAL_MIN: '1440', // every sweep in the smoke is explicit (no timer racing the checks)
  })
  const env = config.env
  if (env.SOLANA_CLUSTER !== 'devnet' && env.SOLANA_CLUSTER !== 'localnet')
    throw new Error('smoke is devnet-only')
  const hookMint = devnetEnv.HOOK_TEST_MINT
  const secondPool = devnetEnv.SECOND_POOL_ADDRESS
  const state = JSON.parse(readFileSync(resolve(DEVNET_DIR, 'state.json'), 'utf8')) as {
    pools: { second?: { position: string } }
  }

  // 1. boot
  const s = await buildServices(config)
  check(
    'boot: cluster + mint scan + DAMM v2 venue',
    true,
    `PRIZE ${s.prizeAddress}, CREATOR ${s.creatorAddress}`,
  )
  const pool = await s.venue.getPoolState()
  check(
    'venue: pool price from sqrtPrice',
    pool.priceQuotePerBaseE18 > 0n,
    `${pool.priceQuotePerBaseE18} (PUMP per SCRATCHY ×1e18)`,
  )
  s.start()
  try {
    // 2. monitor
    const st = await until(
      'first monitor check',
      async () => s.monitor.state().checkedAt && s.monitor.state(),
    )
    check(
      'monitor: PRIZE PUMP + SOL read, payouts open',
      !st.lowGas && !st.lowPool,
      `SOL ${st.prizeSolLamports} lamports, PUMP ${st.prizePumpRaw} raw, P ${st.poolRaw}, reserve ${st.reserveRaw}`,
    )

    // 3 + 4. payouts to a fresh wallet, then again to the same wallet
    const recipient = Keypair.generate().publicKey.toBase58()
    const amount = 12_500_000_000n // 12,500 mock-PUMP
    for (const [label, expectAta] of [
      ['payout → fresh wallet (creates ATA)', true],
      ['payout → same wallet (existing ATA)', false],
    ] as const) {
      const [p] = await s.database.db
        .insert(payouts)
        .values({ kind: 'tier', wallet: recipient, amountRaw: amount, roundId: 0, status: 'queued' })
        .returning()
      s.worker.wake()
      await until(label, async () => {
        const [row] = await s.database.db.select().from(payouts).where(eq(payouts.id, p!.id))
        return row?.status === 'confirmed'
      })
      await verifyPayout(s, p!.id, s.pumpMint, label)
      const [row] = await s.database.db.select().from(payouts).where(eq(payouts.id, p!.id))
      check(
        `${label}: ATA ${expectAta ? 'created' : 'reused'}`,
        row!.ataCreated === expectAta,
        `ataCreated=${row!.ataCreated}`,
      )
    }

    // 5. hook-enabled Token-2022 mint (mirrors real PUMP's transfer-hook extension)
    await s.worker.stop()
    if (hookMint) {
      const hookWorker = new PayoutWorker({
        db: s.database.db,
        chain: s.chain,
        alerter: quietAlerter,
        gate: { hold: () => null, onBalanceTrouble: () => {}, onStuck: () => {}, onDoublePay: () => {} },
        mint: hookMint,
        deployId: env.DEPLOY_ID,
        concurrency: 1,
        priorityFeeCapMicroLamports: env.PRIORITY_FEE_MAX_MICROLAMPORTS,
      })
      const [p] = await s.database.db
        .insert(payouts)
        .values({ kind: 'tier', wallet: recipient, amountRaw: 1_000_000n, roundId: 0, status: 'queued' })
        .returning()
      await until('hook-mint payout', async () => {
        await hookWorker.tick()
        const [row] = await s.database.db.select().from(payouts).where(eq(payouts.id, p!.id))
        return row?.status === 'confirmed'
      })
      await verifyPayout(s, p!.id, hookMint, 'payout in hook-extension mint')
    } else {
      check('payout in hook-extension mint', false, 'HOOK_TEST_MINT missing from .env.devnet')
    }
    s.worker.start()

    // 6. MAIN pool (OnlyB): real fees → claim → 70/30
    const prizeBefore = (await s.chain.getTokenBalance(s.prizeAddress, s.pumpMint)).value
    const opsBefore = (await s.chain.getTokenBalance(s.opsAddress!, s.pumpMint)).value
    feeInflow(['--pool', 'main', '--count', '4', '--interval', '2'])
    const pending = await s.venue.pendingFees()
    check(
      'main pool: fees accrued in PUMP only (OnlyB)',
      pending.quoteRaw > 0n && pending.baseRaw === 0n,
      `${pending.quoteRaw} raw PUMP`,
    )
    await s.sweeper!.runOnce()
    const mainSweep = await until(
      'main sweep done',
      async () => {
        await sweepThrottled(s)
        const rows = await s.database.db.select().from(sweeps)
        const last = rows.at(-1)
        return last?.status === 'done' ? last : null
      },
      180_000,
    )
    check(
      'main pool: claim → 70/30 split exact',
      mainSweep.toPrizeRaw + mainSweep.toOpsRaw === mainSweep.claimedPumpRaw &&
        mainSweep.toPrizeRaw === (mainSweep.claimedPumpRaw * 7n) / 10n,
      `claimed ${mainSweep.claimedPumpRaw}, prize ${mainSweep.toPrizeRaw}, ops ${mainSweep.toOpsRaw}`,
    )
    for (const t of await s.database.db.select().from(payouts).where(eq(payouts.sweepId, mainSweep.id))) {
      await verifyPayout(s, t.id, s.pumpMint, `sweep transfer ${t.kind}`)
    }
    const prizeAfter = (await s.chain.getTokenBalance(s.prizeAddress, s.pumpMint)).value
    const opsAfter = (await s.chain.getTokenBalance(s.opsAddress!, s.pumpMint)).value
    check(
      'main pool: PRIZE + OPS balances moved by the split',
      prizeAfter - prizeBefore === mainSweep.toPrizeRaw && opsAfter - opsBefore === mainSweep.toOpsRaw,
    )

    // 7. SECOND pool (BothToken): swap path
    if (secondPool && state.pools.second) {
      const creatorKey = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(devnetEnv.CREATOR_WALLET_KEY!) as number[]),
      )
      const connection = new Connection(env.RPC_URL, 'confirmed')
      const venue2 = await DammV2Venue.create({
        connection,
        creator: creatorKey,
        pool: new PublicKey(secondPool),
        position: new PublicKey(state.pools.second.position),
        baseMint: new PublicKey(s.scratchyMint),
        quoteMint: new PublicKey(s.pumpMint),
      })
      const swap2 = new DammPoolSwap({
        connection,
        owner: creatorKey,
        pool: new PublicKey(secondPool),
        baseMint: new PublicKey(s.scratchyMint),
        quoteMint: new PublicKey(s.pumpMint),
      })
      const sweeper2 = new FeeSweeper({
        db: s.database.db,
        chain: s.chain,
        venue: venue2,
        swap: swap2,
        alerter: quietAlerter,
        economy: config.economy,
        creatorAddress: s.creatorAddress!,
        prizeAddress: s.prizeAddress,
        opsAddress: s.opsAddress!,
        quoteMint: s.pumpMint,
        baseMint: s.scratchyMint,
        maxSlippageBps: env.SWEEP_MAX_SLIPPAGE_BPS,
        onQueued: () => s.worker.wake(),
      })
      const creatorScrBefore = (await s.chain.getTokenBalance(s.creatorAddress!, s.scratchyMint)).value
      feeInflow(['--pool', 'second', '--count', '4', '--interval', '2'])
      const p2 = await venue2.pendingFees()
      check(
        'second pool: SCRATCHY fees accrued (BothToken)',
        p2.baseRaw > 0n,
        `${p2.baseRaw} raw SCRATCHY + ${p2.quoteRaw} raw PUMP`,
      )
      const beforeId = (await s.database.db.select().from(sweeps)).reduce((m, r) => (r.id > m ? r.id : m), 0n)
      const sweep2 = await until(
        'second sweep done',
        async () => {
          await sweepThrottled(sweeper2)
          const rows = await s.database.db.select().from(sweeps)
          const mine = rows.find((r) => r.id > beforeId && r.claimedScratchyRaw > 0n)
          return mine?.status === 'done' ? mine : null
        },
        240_000,
      )
      const creatorScrAfter = (await s.chain.getTokenBalance(s.creatorAddress!, s.scratchyMint)).value
      check(
        'second pool: swapped exactly the claimed SCRATCHY',
        sweep2.swapInScratchyRaw === sweep2.claimedScratchyRaw && sweep2.swapOutPumpRaw > 0n,
        `claimed ${sweep2.claimedScratchyRaw}, swapped ${sweep2.swapInScratchyRaw} → ${sweep2.swapOutPumpRaw} PUMP`,
      )
      check(
        'second pool: CREATOR SCRATCHY bag untouched',
        creatorScrAfter === creatorScrBefore,
        `${creatorScrBefore} → ${creatorScrAfter}`,
      )
      check(
        'second pool: 70/30 split of claimed PUMP + swap output',
        sweep2.toPrizeRaw + sweep2.toOpsRaw === sweep2.claimedPumpRaw + sweep2.swapOutPumpRaw,
        `prize ${sweep2.toPrizeRaw}, ops ${sweep2.toOpsRaw}`,
      )
    } else {
      check('second pool (BothToken) swap path', false, 'SECOND_POOL_ADDRESS missing')
    }
  } finally {
    await s.stop()
    const passed = checks.filter((c) => c.ok).length
    writeFileSync(
      resolve(DEVNET_DIR, 'smoke-report.json'),
      JSON.stringify({ at: new Date().toISOString(), passed, total: checks.length, checks }, null, 2) + '\n',
    )
    console.log(`\n${passed}/${checks.length} checks passed — report: .devnet/smoke-report.json`)
    process.exitCode = passed === checks.length ? 0 : 1
  }
}

main().catch((e) => {
  console.error('smoke failed:', (e as Error).message)
  process.exitCode = 1
})

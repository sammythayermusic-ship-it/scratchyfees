/**
 * "Fake fee inflow" for the devnet rehearsal (PLAN §8): TRADER swaps back and forth against the MAIN
 * DAMM v2 pool (and optionally the SECOND, BothToken pool), so real trading fees accrue to CREATOR's
 * position the way organic volume would on mainnet. Prints CREATOR's pending (unclaimed) fees before and
 * after via the SDK's getUnClaimLpFee. DEVNET ONLY (genesis-gated in lib.ts). Only TRADER's key is
 * loaded; CREATOR's key is never read (claiming is the sweeper's job).
 *
 *   pnpm --filter @scratchy/api exec tsx scripts/devnet/fee-inflow.ts [--count 10] [--size 100000]
 *        [--interval 3] [--pool main|second|both] [--second-size 2000] [--slippage-bps 100] [--dry-run]
 *
 * Swaps alternate: a buy (mock-PUMP → mock-SCRATCHY, `size` PUMP in) then a sell of exactly the SCRATCHY
 * that buy returned (swap2, ExactIn, explicit minimum out). Each pair leaves the price roughly where it
 * started, and TRADER's inventory shrinks only by the fees. On the MAIN pool (collectFeeMode OnlyB) every
 * fee is taken in PUMP: 3% of volume, of which Meteora's protocol share (pool protocolFeePercent) never
 * reaches the LP. The SECOND pool (BothToken) takes the fee in the output token, so buys accrue SCRATCHY
 * fees there: the non-zero SCRATCHY delta the sweeper's swap step needs.
 */
import {
  CpAmm,
  SwapMode,
  TradeDirection,
  getFeeMode,
  getTokenProgram,
  getUnClaimLpFee,
  type PoolState,
} from '@meteora-ag/cp-amm-sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey, type Connection, type Keypair } from '@solana/web3.js'
import BN from 'bn.js'
import { existsSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  airdropWithBackoff,
  connectDevnet,
  envFilePath,
  errMessage,
  explorerUrl,
  fail,
  fmtSol,
  fmtUsdE18,
  formatUnits,
  getSolBalances,
  loadKeypairFile,
  loadState,
  parseUnits,
  sendAndConfirm,
  sleep,
  tokenAccountBalance,
  usdE18OfQuote,
  type DevnetConnection,
  type PoolRecord,
} from './lib'

const DECIMALS = 6
const MOCK_PUMP_USD_E18 = parseUnits('0.0056', 18)
/** below this TRADER is topped back up (faucet, or exact manual instructions + exit 2) */
const TRADER_MIN_SOL = 20_000_000n
const TRADER_TARGET_SOL = 300_000_000n
const SWAP_COMPUTE_UNITS = 300_000

const HELP = `devnet fee inflow: TRADER swaps against the DAMM v2 pool(s) so 3% fees accrue to CREATOR (DEVNET ONLY)

  pnpm --filter @scratchy/api exec tsx scripts/devnet/fee-inflow.ts [options]

  --count <n>           swaps per pool, alternating buy/sell, starting with a buy (default 10)
  --size <mPUMP>        mock-PUMP spent per buy on the MAIN pool (default 100000)
  --second-size <mPUMP> mock-PUMP spent per buy on the SECOND pool (default 2000)
  --interval <sec>      pause between swaps (default 3)
  --pool <p>            main | second | both (default main)
  --slippage-bps <bps>  minimum-out tolerance passed to every swap (default 100)
  --dry-run             print quotes and pending fees; send nothing
  --no-airdrop          if TRADER is low on SOL, print funding instructions (exit 2) instead of the faucet
  -h, --help

Ctrl-C stops after the swap in flight and still prints the fee report.
env: RPC_URL (default: the RPC_URL in .env.devnet, else https://api.devnet.solana.com),
     LOCALNET=1 (loopback test validator only)`

function parseCli() {
  const { values } = parseArgs({
    options: {
      count: { type: 'string', default: '10' },
      size: { type: 'string', default: '100000' },
      'second-size': { type: 'string', default: '2000' },
      interval: { type: 'string', default: '3' },
      pool: { type: 'string', default: 'main' },
      'slippage-bps': { type: 'string', default: '100' },
      'dry-run': { type: 'boolean', default: false },
      'no-airdrop': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  })
  const int = (name: string, v: string, min: number, max: number) => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < min || n > max)
      return fail(`--${name} must be an integer in [${min}, ${max}]`)
    return n
  }
  const units = (name: string, v: string) => {
    try {
      const raw = parseUnits(v, DECIMALS)
      if (raw <= 0n) throw new Error('must be > 0')
      return raw
    } catch (e) {
      return fail(`--${name}: ${errMessage(e)}`)
    }
  }
  const pool = values.pool
  if (pool !== 'main' && pool !== 'second' && pool !== 'both')
    return fail('--pool must be main, second or both')
  const interval = Number(values.interval)
  if (!Number.isFinite(interval) || interval < 0 || interval > 3600)
    return fail('--interval must be 0…3600 seconds')
  return {
    count: int('count', values.count, 1, 1_000),
    sizeRaw: units('size', values.size),
    secondSizeRaw: units('second-size', values['second-size']),
    intervalMs: Math.round(interval * 1000),
    pool,
    slippageBps: int('slippage-bps', values['slippage-bps'], 1, 5_000),
    dryRun: values['dry-run'],
    noAirdrop: values['no-airdrop'],
    help: values.help,
  }
}

type Cli = ReturnType<typeof parseCli>

interface Lane {
  label: 'MAIN' | 'SECOND'
  rec: PoolRecord
  pool: PublicKey
  position: PublicKey
  sizeRaw: bigint
  /** SCRATCHY received by the last buy: the next sell's input */
  lastBoughtRaw: bigint
  volumeQuoteRaw: bigint
  swaps: number
}

interface Ctx {
  net: DevnetConnection
  conn: Connection
  cpAmm: CpAmm
  trader: Keypair
  cli: Cli
}

const bn = (v: bigint) => new BN(v.toString())
const big = (v: BN) => BigInt(v.toString())
const tok = (raw: bigint) => formatUnits(raw, DECIMALS)
const pumpUsd = (raw: bigint) => fmtUsdE18(usdE18OfQuote(raw, MOCK_PUMP_USD_E18, DECIMALS))

interface Pending {
  scratchyRaw: bigint
  pumpRaw: bigint
  protocolFeePercent: number
}

/** CREATOR's unclaimed LP fees on this position (tokenA = mock-SCRATCHY, tokenB = mock-PUMP) */
async function pendingFees(ctx: Ctx, lane: Lane): Promise<Pending> {
  const [ps, pos] = await Promise.all([
    ctx.cpAmm.fetchPoolState(lane.pool),
    ctx.cpAmm.fetchPositionState(lane.position),
  ])
  const fees = getUnClaimLpFee(ps, pos)
  return {
    scratchyRaw: big(fees.feeTokenA),
    pumpRaw: big(fees.feeTokenB),
    protocolFeePercent: ps.poolFees.protocolFeePercent,
  }
}

async function currentTime(conn: Connection): Promise<{ slot: number; unix: number }> {
  const slot = await conn.getSlot('confirmed')
  const t = await conn.getBlockTime(slot).catch(() => null)
  return { slot, unix: t ?? Math.floor(Date.now() / 1000) }
}

async function swapOnce(ctx: Ctx, lane: Lane, n: number, side: 'buy' | 'sell'): Promise<void> {
  const { conn, cpAmm, trader, cli } = ctx
  const ps: PoolState = await cpAmm.fetchPoolState(lane.pool)
  const buy = side === 'buy'
  const tokenAProgram = getTokenProgram(ps.tokenAFlag)
  const tokenBProgram = getTokenProgram(ps.tokenBFlag)
  const inputMint = buy ? ps.tokenBMint : ps.tokenAMint
  const outputMint = buy ? ps.tokenAMint : ps.tokenBMint
  const inProgram = buy ? tokenBProgram : tokenAProgram
  const outProgram = buy ? tokenAProgram : tokenBProgram
  const inSym = buy ? 'mPUMP' : 'mSCRATCHY'
  const outSym = buy ? 'mSCRATCHY' : 'mPUMP'
  const amountIn = buy ? lane.sizeRaw : lane.lastBoughtRaw
  const tag = `#${String(n).padStart(3)} ${lane.label.padEnd(6)} ${side.padEnd(4)}`
  if (amountIn <= 0n) {
    console.log(`${tag} skipped (nothing bought yet to sell)`)
    return
  }

  const inAta = getAssociatedTokenAddressSync(inputMint, trader.publicKey, false, inProgram)
  const outAta = getAssociatedTokenAddressSync(outputMint, trader.publicKey, false, outProgram)
  const have = await tokenAccountBalance(conn, inAta, inProgram)
  if (have < amountIn && !cli.dryRun) {
    return fail(`TRADER holds ${tok(have)} ${inSym} but this ${side} needs ${tok(amountIn)}; lower --size`)
  }

  const now = await currentTime(conn)
  const quote = cpAmm.getQuote({
    inAmount: bn(amountIn),
    inputTokenMint: inputMint,
    slippage: cli.slippageBps,
    poolState: ps,
    currentTime: now.unix,
    currentSlot: now.slot,
    tokenADecimal: DECIMALS,
    tokenBDecimal: DECIMALS,
  })
  const feeMode = getFeeMode(ps.collectFeeMode, buy ? TradeDirection.BtoA : TradeDirection.AtoB, false)
  const feeSym = feeMode.feesOnTokenA ? 'mSCRATCHY' : 'mPUMP'
  const expectedOut = big(quote.swapOutAmount)
  const minOut = big(quote.minSwapOutAmount)
  const feeNote = `fee ≈ ${tok(big(quote.totalFee))} ${feeSym}`

  if (cli.dryRun) {
    console.log(
      `${tag} quote ${tok(amountIn)} ${inSym} → ${tok(expectedOut)} ${outSym} (min ${tok(minOut)}), ${feeNote}`,
    )
    if (buy) lane.lastBoughtRaw = expectedOut
    lane.volumeQuoteRaw += buy ? amountIn : expectedOut
    lane.swaps++
    return
  }

  const tx = await cpAmm.swap2({
    payer: trader.publicKey,
    pool: lane.pool,
    inputTokenMint: inputMint,
    outputTokenMint: outputMint,
    tokenAMint: ps.tokenAMint,
    tokenBMint: ps.tokenBMint,
    tokenAVault: ps.tokenAVault,
    tokenBVault: ps.tokenBVault,
    tokenAProgram,
    tokenBProgram,
    referralTokenAccount: null,
    poolState: ps,
    swapMode: SwapMode.ExactIn,
    amountIn: bn(amountIn),
    minimumAmountOut: quote.minSwapOutAmount,
  })
  const outBefore = await tokenAccountBalance(conn, outAta, outProgram)
  const signature = await sendAndConfirm(conn, tx, [trader], {
    label: `${lane.label} ${side}`,
    computeUnits: SWAP_COMPUTE_UNITS,
  })
  const received = (await tokenAccountBalance(conn, outAta, outProgram)) - outBefore
  if (buy) lane.lastBoughtRaw = received
  lane.volumeQuoteRaw += buy ? amountIn : received
  lane.swaps++
  console.log(
    `${tag} ${tok(amountIn)} ${inSym} → ${tok(received)} ${outSym}, ${feeNote}  ` +
      `${explorerUrl('tx', signature, ctx.net.cluster, ctx.net.rpcUrl)}`,
  )
}

function printPending(label: string, when: string, p: Pending): void {
  console.log(
    `  ${label.padEnd(6)} ${when.padEnd(7)} ${tok(p.pumpRaw).padStart(20)} mPUMP (~${pumpUsd(p.pumpRaw)})` +
      ` · ${tok(p.scratchyRaw)} mSCRATCHY`,
  )
}

/** RPC_URL from the shell, else the one setup recorded in .env.devnet (the node the API and smoke use) */
function envWithRecordedRpc(): NodeJS.ProcessEnv {
  if (process.env.RPC_URL?.trim() || process.env.LOCALNET === '1') return process.env
  const path = envFilePath('devnet')
  if (!existsSync(path)) return process.env
  const m = /^\s*RPC_URL\s*=\s*(\S+)\s*$/m.exec(readFileSync(path, 'utf8'))
  return m?.[1] ? { ...process.env, RPC_URL: m[1] } : process.env
}

async function main(): Promise<void> {
  const cli = parseCli()
  if (cli.help) {
    console.log(HELP)
    return
  }
  console.log('$SCRATCHY devnet fee inflow (DEVNET ONLY)')
  const net = await connectDevnet(envWithRecordedRpc()) // genesis-gated either way
  const { conn, cluster } = net
  const state = loadState(cluster, net.genesisHash)
  const traderAddress = state.wallets.trader
  if (!state.pools.main || !traderAddress || !state.wallets.creator) {
    return fail('no MAIN pool / TRADER in .devnet state: run scripts/devnet/setup.ts first')
  }
  const trader = loadKeypairFile('trader')
  if (trader.publicKey.toBase58() !== traderAddress) {
    return fail('.devnet/keys/trader.json does not match the TRADER recorded in state.json')
  }

  const lanes: Lane[] = []
  const lane = (label: Lane['label'], rec: PoolRecord, sizeRaw: bigint): Lane => ({
    label,
    rec,
    pool: new PublicKey(rec.address),
    position: new PublicKey(rec.position),
    sizeRaw,
    lastBoughtRaw: 0n,
    volumeQuoteRaw: 0n,
    swaps: 0,
  })
  if (cli.pool === 'main' || cli.pool === 'both') lanes.push(lane('MAIN', state.pools.main, cli.sizeRaw))
  if (cli.pool === 'second' || cli.pool === 'both') {
    if (!state.pools.second) return fail('no SECOND pool recorded: run setup.ts without --skip-second-pool')
    lanes.push(lane('SECOND', state.pools.second, cli.secondSizeRaw))
  }

  const ctx: Ctx = { net, conn, cpAmm: new CpAmm(conn), trader, cli }
  const totalSwaps = cli.count * lanes.length
  const perSwap = 5_000n + (BigInt(SWAP_COMPUTE_UNITS) * 5_000n) / 1_000_000n
  const [solBal = 0n] = await getSolBalances(conn, [trader.publicKey])
  console.log(`\n══ SOL BUDGET ══`)
  console.log(`  TRADER ${traderAddress}  balance ${fmtSol(solBal)}`)
  console.log(
    `  ${totalSwaps} swaps × ≤ ${fmtSol(perSwap)} (signature + priority fee at ${SWAP_COMPUTE_UNITS} CU) ` +
      `≈ ${fmtSol(perSwap * BigInt(totalSwaps))}; first swaps may also pay ~0.002 SOL rent per new token account`,
  )
  if (!cli.dryRun && solBal < TRADER_MIN_SOL) {
    await airdropWithBackoff(conn, trader.publicKey, TRADER_TARGET_SOL, {
      label: 'TRADER',
      noAirdrop: cli.noAirdrop,
    })
  }

  console.log(`\nCREATOR pending fees (unclaimed; mock PUMP at $0.0056)`)
  const before = new Map<Lane, Pending>()
  for (const l of lanes) {
    const p = await pendingFees(ctx, l)
    before.set(l, p)
    printPending(l.label, 'before', p)
  }

  let stop = false
  process.once('SIGINT', () => {
    stop = true
    console.log('\n(stopping after the swap in flight…)')
  })
  console.log(
    `\n${cli.dryRun ? 'quotes (dry run, nothing sent)' : 'swaps'}: ${cli.count} per pool, alternating buy/sell, ` +
      `slippage ${cli.slippageBps} bps, every ${cli.intervalMs / 1000}s`,
  )
  let n = 0
  for (let i = 0; i < cli.count && !stop; i++) {
    const side = i % 2 === 0 ? 'buy' : 'sell'
    for (const l of lanes) {
      if (stop) break
      n++
      await swapOnce(ctx, l, n, side)
      if (!cli.dryRun && cli.intervalMs > 0 && n < totalSwaps && !stop) await sleep(cli.intervalMs)
    }
  }

  console.log(`\nCREATOR pending fees after ${cli.dryRun ? '(unchanged: dry run)' : ''}`)
  for (const l of lanes) {
    const b = before.get(l)
    const a = await pendingFees(ctx, l)
    if (b) printPending(l.label, 'before', b)
    printPending(l.label, 'after', a)
    if (!b) continue
    const dPump = a.pumpRaw - b.pumpRaw
    const dScratchy = a.scratchyRaw - b.scratchyRaw
    const rate =
      l.volumeQuoteRaw > 0n && l.rec.collectFeeMode === 'OnlyB'
        ? ` = ${formatUnits((dPump * 1_000_000n) / l.volumeQuoteRaw, 4, 2)}% of ${tok(l.volumeQuoteRaw)} mPUMP volume ` +
          `(pool fee ${(l.rec.feeBps / 100).toFixed(2)}% minus Meteora's ${a.protocolFeePercent}% protocol share)`
        : ` over ${l.swaps} swaps (${tok(l.volumeQuoteRaw)} mPUMP volume)`
    console.log(
      `  ${l.label.padEnd(6)} accrued +${tok(dPump)} mPUMP (~${pumpUsd(dPump)}) · +${tok(dScratchy)} mSCRATCHY${rate}`,
    )
  }
  if (!cli.dryRun)
    console.log(
      "\nclaim + 70/30 split is the sweeper's job (VENUE=damm-v2 with the addresses in .env.devnet)",
    )
}

main().then(
  () => process.exit(0), // the SDK's RPC websocket can keep the event loop alive
  (e: unknown) => fail(errMessage(e)),
)

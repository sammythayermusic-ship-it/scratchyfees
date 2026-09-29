import { DEFAULT_ECONOMY } from '@scratchy/core'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AlertEvent, Alerter } from '../src/alerts/types'
import { MemoryChainClient } from '../src/chain/memory'
import type { Database } from '../src/db/client'
import { payouts, prizeLedger, sweeps } from '../src/db/schema'
import { PayoutWorker, type PayoutGate } from '../src/payouts/worker'
import { FeeSweeper } from '../src/sweeper/sweeper'
import { MemorySwap, MemoryVenue } from '../src/venue/memory'
import { freshDatabase } from './helpers/db'

const PRIZE = 'PrizeWallet1111111111111111111111111111111'
const CREATOR = 'CreatorWa11et111111111111111111111111111111'
const OPS = 'OpsWa11et111111111111111111111111111111111'
const PUMP = 'MockPump11111111111111111111111111111111111'
const SCR = 'MockScratchy111111111111111111111111111111'
const TRADER = 'Trader1111111111111111111111111111111111111'

class TestAlerter implements Alerter {
  events: AlertEvent[] = []
  notify(e: AlertEvent) {
    this.events.push(e)
  }
  async flush() {}
}

let database: Database
let chain: MemoryChainClient
let alerter: TestAlerter
let gate: { hold: string | null } & PayoutGate

function setup(mode: 'OnlyB' | 'BothToken') {
  const venue = new MemoryVenue({
    chain,
    creator: CREATOR,
    baseMint: SCR,
    quoteMint: PUMP,
    baseDecimals: 6,
    quoteDecimals: 6,
    baseReserveRaw: 1_000_000_000_000_000n, // 1B SCRATCHY
    quoteReserveRaw: 10_000_000_000_000n, // 10M PUMP
    collectFeeMode: mode,
  })
  const swap = new MemorySwap(venue, chain, CREATOR, SCR, PUMP)
  const worker = new PayoutWorker({
    db: database.db,
    chain,
    alerter,
    gate,
    mint: PUMP,
    deployId: 'test',
    concurrency: 4,
    priorityFeeCapMicroLamports: 100_000,
  })
  const sweeper = new FeeSweeper({
    db: database.db,
    chain,
    venue,
    swap,
    alerter,
    economy: DEFAULT_ECONOMY,
    creatorAddress: CREATOR,
    prizeAddress: PRIZE,
    opsAddress: OPS,
    quoteMint: PUMP,
    maxSlippageBps: 300,
  })
  return { venue, swap, worker, sweeper }
}

async function deliver(worker: PayoutWorker, ticks = 4) {
  for (let i = 0; i < ticks; i++) {
    await worker.tick()
    chain.advance(1)
  }
}

beforeEach(async () => {
  database = await freshDatabase()
  chain = new MemoryChainClient({
    prizeAddress: PRIZE,
    creatorAddress: CREATOR,
    mints: [
      { address: PUMP, decimals: 6, token2022: true },
      { address: SCR, decimals: 6 },
    ],
    validityBlocks: 10,
  })
  chain.setSol(PRIZE, 1_000_000_000n)
  chain.setSol(CREATOR, 1_000_000_000n)
  alerter = new TestAlerter()
  gate = {
    hold: null,
    globalHold() {
      return this.hold
    },
    onBalanceTrouble() {},
  }
})

afterEach(async () => {
  await database.close()
})

describe('fee sweeper', () => {
  it('OnlyB: claims PUMP fees and splits them exactly 70/30 with exactly-once transfers', async () => {
    const { venue, worker, sweeper } = setup('OnlyB')
    venue.trade('buy', 1_000_000_000_000n) // 1M PUMP of buys → 3% fee → 80% to LPs = 24,000 PUMP
    venue.trade('sell', 50_000_000_000_000n)
    const pending = (await venue.pendingFees()).quoteRaw
    expect((await venue.pendingFees()).baseRaw).toBe(0n)

    const out = await sweeper.runOnce()
    expect(out.claimed?.claimedPumpRaw).toBe(pending)
    await deliver(worker)
    await sweeper.runOnce() // marks done

    const [s] = await database.db.select().from(sweeps)
    expect(s!.status).toBe('done')
    expect(s!.toPrizeRaw + s!.toOpsRaw).toBe(pending)
    expect(s!.toPrizeRaw).toBe((pending * 7n) / 10n)
    expect((await chain.getTokenBalance(PRIZE, PUMP)).value).toBe(s!.toPrizeRaw)
    expect((await chain.getTokenBalance(OPS, PUMP)).value).toBe(s!.toOpsRaw)
    expect((await chain.getTokenBalance(CREATOR, PUMP)).value).toBe(0n)
    const ledger = await database.db.select().from(prizeLedger)
    expect(ledger.map((l) => [l.kind, l.amountRaw])).toEqual([['sweep_in', s!.toPrizeRaw]])
  })

  it('BothToken: swaps ONLY the claimed SCRATCHY (never the creator bag) and splits the swap output too', async () => {
    const { venue, worker, sweeper } = setup('BothToken')
    chain.credit(CREATOR, SCR, 777_000_000n) // CREATOR's own bag — must never be touched
    venue.trade('buy', 1_000_000_000_000n)
    venue.trade('sell', 50_000_000_000_000n)
    const fees = await venue.pendingFees()
    expect(fees.baseRaw).toBeGreaterThan(0n)

    await sweeper.runOnce()
    await deliver(worker)
    await sweeper.runOnce()

    const [s] = await database.db.select().from(sweeps)
    expect(s!.status).toBe('done')
    expect(s!.swapInScratchyRaw).toBe(fees.baseRaw)
    expect(s!.swapOutPumpRaw).toBeGreaterThan(0n)
    expect(s!.toPrizeRaw + s!.toOpsRaw).toBe(fees.quoteRaw + s!.swapOutPumpRaw)
    expect((await chain.getTokenBalance(CREATOR, SCR)).value).toBe(777_000_000n)
  })

  it('a swap failure still splits the PUMP part; the SCRATCHY is swapped and split on the next run', async () => {
    const { venue, swap, worker, sweeper } = setup('BothToken')
    venue.trade('buy', 1_000_000_000_000n)
    venue.trade('sell', 50_000_000_000_000n)
    const fees = await venue.pendingFees()
    swap.failNext = 1
    await sweeper.runOnce()
    let [s] = await database.db.select().from(sweeps)
    expect(s!.status).toBe('split')
    expect(s!.toPrizeRaw + s!.toOpsRaw).toBe(fees.quoteRaw)
    expect(alerter.events.some((e) => e.kind === 'sweep.swap_failed')).toBe(true)
    await deliver(worker)
    await sweeper.runOnce() // swap succeeds now → second tranche queued
    await deliver(worker)
    await sweeper.runOnce()
    ;[s] = await database.db.select().from(sweeps)
    expect(s!.status).toBe('done')
    expect(s!.swapInScratchyRaw).toBe(fees.baseRaw)
    expect(s!.toPrizeRaw + s!.toOpsRaw).toBe(fees.quoteRaw + s!.swapOutPumpRaw)
    const tranches = await database.db.select().from(payouts).where(eq(payouts.sweepId, s!.id))
    expect(tranches).toHaveLength(4)
    expect(tranches.every((t) => t.status === 'confirmed')).toBe(true)
  })

  it('a failed claim moves nothing, alerts, and the next run claims again', async () => {
    const { venue, worker, sweeper } = setup('OnlyB')
    venue.trade('buy', 1_000_000_000_000n)
    venue.failClaimsNext = 1
    await sweeper.runOnce()
    expect((await database.db.select().from(sweeps))[0]!.status).toBe('failed')
    expect(alerter.events.some((e) => e.kind === 'sweep.claim_failed')).toBe(true)
    await sweeper.runOnce()
    await deliver(worker)
    await sweeper.runOnce()
    const rows = await database.db.select().from(sweeps)
    expect(rows.map((r) => r.status)).toEqual(['failed', 'done'])
  })

  it('an interrupted claim is never guessed at: marked failed and unattributed CREATOR PUMP is flagged', async () => {
    const { sweeper } = setup('OnlyB')
    await database.db.insert(sweeps).values({ status: 'claiming' })
    chain.credit(CREATOR, PUMP, 5_000n) // the claim did land before the crash
    await sweeper.runOnce()
    expect((await database.db.select().from(sweeps))[0]!.status).toBe('failed')
    expect(alerter.events.some((e) => e.kind === 'sweep.orphan')).toBe(true)
  })

  it('sweeps keep flowing while prize payouts are held (refilling the pool is what a low-pool pause needs)', async () => {
    const { venue, worker, sweeper } = setup('OnlyB')
    gate.hold = 'low_pool'
    venue.trade('buy', 1_000_000_000_000n)
    await sweeper.runOnce()
    await deliver(worker)
    await sweeper.runOnce()
    expect((await database.db.select().from(sweeps))[0]!.status).toBe('done')
  })
})

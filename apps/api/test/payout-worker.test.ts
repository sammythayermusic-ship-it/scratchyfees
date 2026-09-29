import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AlertEvent, Alerter } from '../src/alerts/types'
import { MemoryChainClient } from '../src/chain/memory'
import type { Database } from '../src/db/client'
import { payoutAttempts, payouts, prizeLedger, wallets } from '../src/db/schema'
import { MAX_ATTEMPTS, PayoutWorker, type PayoutGate } from '../src/payouts/worker'
import { freshDatabase } from './helpers/db'

const PRIZE = 'PrizeWallet1111111111111111111111111111111'
const MINT = 'MockPump11111111111111111111111111111111111'
const ALICE = 'Alice111111111111111111111111111111111111111'
const BOB = 'Bob11111111111111111111111111111111111111111'

class TestAlerter implements Alerter {
  events: AlertEvent[] = []
  notify(e: AlertEvent) {
    this.events.push(e)
  }
  async flush() {}
}

class TestGate implements PayoutGate {
  hold: string | null = null
  trouble: string[] = []
  globalHold() {
    return this.hold
  }
  onBalanceTrouble(kind: 'low_gas' | 'low_pool') {
    this.trouble.push(kind)
  }
}

let database: Database
let chain: MemoryChainClient
let alerter: TestAlerter
let gate: TestGate
let clock: number

function worker(id = 'w1') {
  return new PayoutWorker({
    db: database.db,
    chain,
    alerter,
    gate,
    mint: MINT,
    deployId: 'test',
    concurrency: 4,
    priorityFeeCapMicroLamports: 100_000,
    now: () => new Date(clock),
    workerId: id,
  })
}

async function queue(wallet: string, amount: bigint, roundId = 1) {
  const [p] = await database.db
    .insert(payouts)
    .values({ kind: 'tier', wallet, amountRaw: amount, roundId, status: 'queued' })
    .returning()
  return p!
}

async function payout(id: bigint) {
  const [p] = await database.db.select().from(payouts).where(eq(payouts.id, id))
  return p!
}

/** run ticks while advancing the chain, like the real loop would */
async function drive(w: PayoutWorker, rounds: number, blocksPerTick = 1, msPerTick = 2_000) {
  for (let i = 0; i < rounds; i++) {
    await w.tick()
    chain.advance(blocksPerTick)
    clock += msPerTick
  }
}

beforeEach(async () => {
  database = await freshDatabase()
  chain = new MemoryChainClient({
    prizeAddress: PRIZE,
    mints: [{ address: MINT, decimals: 6, token2022: true }],
    validityBlocks: 10,
    finalityLag: 2,
    landingDelay: 1,
  })
  chain.setSol(PRIZE, 1_000_000_000n)
  chain.credit(PRIZE, MINT, 1_000_000_000_000n)
  alerter = new TestAlerter()
  gate = new TestGate()
  clock = Date.parse('2026-09-29T12:00:00Z')
  await database.db.insert(wallets).values([{ address: ALICE }, { address: BOB }])
})

afterEach(async () => {
  await database.close()
})

describe('payout worker — exactly once', () => {
  it('happy path: queued → sending → confirmed, ledgered, wallet credited, ATA rent paid once', async () => {
    const p = await queue(ALICE, 12_500_000_000n)
    const w = worker()
    await drive(w, 4)
    const done = await payout(p.id)
    expect(done.status).toBe('confirmed')
    expect(done.txSig).toBeTruthy()
    expect(done.ataCreated).toBe(true)
    expect((await chain.getTokenBalance(ALICE, MINT)).value).toBe(12_500_000_000n)
    expect(chain.txCount()).toBe(1)
    const ledger = await database.db.select().from(prizeLedger)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.amountRaw).toBe(-12_500_000_000n)
    const [a] = await database.db.select().from(wallets).where(eq(wallets.address, ALICE))
    expect(a!.totalWonRaw).toBe(12_500_000_000n)
    expect(a!.ataCreatedCount).toBe(1)
  })

  it('a dropped tx is re-broadcast with IDENTICAL bytes, then rebuilt only after proven expiry', async () => {
    const p = await queue(ALICE, 1_000n)
    chain.faults.dropNext = 1
    const w = worker()
    await drive(w, 6, 1)
    const attempts1 = await database.db.select().from(payoutAttempts).where(eq(payoutAttempts.payoutId, p.id))
    expect(attempts1).toHaveLength(1) // still inside the blockhash lifetime: no second attempt
    const sig1 = attempts1[0]!.signature
    expect(chain.sendLog.filter((s) => s === sig1).length).toBeGreaterThan(1) // re-broadcasts
    await drive(w, 20, 1)
    const done = await payout(p.id)
    expect(done.status).toBe('confirmed')
    const attempts = await database.db.select().from(payoutAttempts).where(eq(payoutAttempts.payoutId, p.id))
    expect(attempts.map((a) => a.status)).toEqual(['expired', 'landed'])
    expect(chain.txCount()).toBe(1)
    expect((await chain.getTokenBalance(ALICE, MINT)).value).toBe(1_000n)
  })

  it('crash between persisting the attempt and sending it: the persisted bytes are delivered once', async () => {
    const p = await queue(ALICE, 777n)
    chain.faults.sendThrowsNext = 1
    const w = worker()
    await drive(w, 5)
    expect((await payout(p.id)).status).toBe('confirmed')
    expect(chain.txCount()).toBe(1)
    const attempts = await database.db.select().from(payoutAttempts).where(eq(payoutAttempts.payoutId, p.id))
    expect(attempts).toHaveLength(1)
  })

  it('a lagging RPC view can never trigger a rebuild (no double pay when the first attempt landed late)', async () => {
    const p = await queue(ALICE, 5_000n)
    chain.faults.statusLagSlots = 50 // the status view never catches up past the expiry point
    const w = worker()
    await drive(w, 30, 1) // first attempt lands after 1 block, but the lagging view can't see it
    let attempts = await database.db.select().from(payoutAttempts).where(eq(payoutAttempts.payoutId, p.id))
    expect(attempts).toHaveLength(1) // no rebuild without a proof
    expect((await payout(p.id)).status).toBe('sending')
    chain.faults.statusLagSlots = 0
    await drive(w, 2)
    expect((await payout(p.id)).status).toBe('confirmed')
    attempts = await database.db.select().from(payoutAttempts).where(eq(payoutAttempts.payoutId, p.id))
    expect(attempts).toHaveLength(1)
    expect(chain.txCount()).toBe(1)
  })

  it('an on-chain failure is rebuilt (the failed tx moved nothing)', async () => {
    const p = await queue(BOB, 42n)
    chain.faults.failNextOnChain = { count: 1, error: 'custom program error: 0x7' }
    await drive(worker(), 6)
    expect((await payout(p.id)).status).toBe('confirmed')
    const attempts = await database.db.select().from(payoutAttempts).where(eq(payoutAttempts.payoutId, p.id))
    expect(attempts.map((a) => a.status)).toEqual(['failed_onchain', 'landed'])
    expect((await chain.getTokenBalance(BOB, MINT)).value).toBe(42n)
  })

  it(`after ${MAX_ATTEMPTS} provably-failed attempts → failed (auto-retry queue) → later succeeds`, async () => {
    const p = await queue(BOB, 99n)
    chain.faults.failNextOnChain = { count: MAX_ATTEMPTS, error: 'custom program error: 0x7' }
    const w = worker()
    await drive(w, 12)
    const failed = await payout(p.id)
    expect(failed.status).toBe('failed')
    expect(failed.nextAttemptAt).toBeTruthy()
    expect(alerter.events.some((e) => e.kind === 'payout.failed')).toBe(true)
    clock += 10 * 60_000 // past the backoff
    await drive(w, 4)
    expect((await payout(p.id)).status).toBe('confirmed')
    expect((await chain.getTokenBalance(BOB, MINT)).value).toBe(99n)
  })

  it('low gas pauses via the gate instead of failing the payout', async () => {
    chain.setSol(PRIZE, 0n)
    const p = await queue(ALICE, 10n)
    await drive(worker(), 2)
    expect(gate.trouble).toContain('low_gas')
    expect((await payout(p.id)).status).toBe('queued')
  })

  it('a global hold blocks new attempts but in-flight ones still confirm', async () => {
    const inFlight = await queue(ALICE, 10n)
    const w = worker()
    await w.tick() // attempt sent
    gate.hold = 'manual'
    const waiting = await queue(BOB, 20n)
    await drive(w, 4)
    expect((await payout(inFlight.id)).status).toBe('confirmed')
    expect((await payout(waiting.id)).status).toBe('queued')
    gate.hold = null
    await drive(w, 4)
    expect((await payout(waiting.id)).status).toBe('confirmed')
  })

  it('deterministic errors become failed_permanent with a critical alert', async () => {
    const p = await queue(ALICE, 10n)
    chain.faults.simulateErrorNext = { count: 1, error: 'custom program error: 0x11', permanent: true }
    await drive(worker(), 2)
    expect((await payout(p.id)).status).toBe('failed_permanent')
    expect(
      alerter.events.some((e) => e.kind === 'payout.failed_permanent' && e.severity === 'critical'),
    ).toBe(true)
    expect(chain.txCount()).toBe(0)
  })

  it('two identical prizes to the same wallet are two distinct transfers (memo makes each tx unique)', async () => {
    await queue(ALICE, 500n)
    await queue(ALICE, 500n)
    await drive(worker(), 5)
    expect(chain.txCount()).toBe(2)
    expect((await chain.getTokenBalance(ALICE, MINT)).value).toBe(1_000n)
  })

  it('two workers racing over the same queue still pay each payout exactly once', async () => {
    const ids: bigint[] = []
    for (let i = 0; i < 20; i++) ids.push((await queue(i % 2 ? ALICE : BOB, BigInt(100 + i))).id)
    const w1 = worker('w1')
    const w2 = worker('w2')
    for (let i = 0; i < 8; i++) {
      await Promise.all([w1.tick(), w2.tick()])
      chain.advance(1)
      clock += 2_000
    }
    const rows = await database.db.select().from(payouts)
    expect(rows.every((r) => r.status === 'confirmed')).toBe(true)
    expect(chain.txCount()).toBe(20)
    const expected = ids.reduce((s, _, i) => s + BigInt(100 + i), 0n)
    const paid =
      (await chain.getTokenBalance(ALICE, MINT)).value + (await chain.getTokenBalance(BOB, MINT)).value
    expect(paid).toBe(expected)
  })
})

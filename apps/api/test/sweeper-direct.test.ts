import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import type { AlertEvent, Alerter } from '../src/alerts/types'
import type { Database } from '../src/db/client'
import { prizeLedger, sweeps } from '../src/db/schema'
import { loadConfig } from '../src/env'
import { buildServices, devAddress, type Services } from '../src/services'
import { DirectFeeSweeper } from '../src/sweeper/direct'
import type { ClaimResult, PoolState, VenueAdapter } from '../src/venue/types'
import { freshDatabase } from './helpers/db'

/**
 * The direct sweeper (pump.fun sharing config): one claim pays PRIZE and OPS straight from the venue, so a
 * sweep is claim → book. These tests drive it with a fake direct venue on top of the memory chain and check
 * the ledger + the reconciler hand-off (no double counting, no false invariant pause).
 */

class TestAlerter implements Alerter {
  events: AlertEvent[] = []
  notify(e: AlertEvent) {
    this.events.push(e)
  }
  async flush() {}
}

/** A venue whose claim "lands" by crediting PRIZE/OPS on the memory chain (as the sharing config does). */
class FakeDirectVenue implements VenueAdapter {
  readonly name = 'pumpfun'
  readonly distributesDirectly = true
  pendingRaw = 0n
  failNext: Error | null = null
  claims = 0
  constructor(private readonly s: Services) {}
  excludedAddresses() {
    return []
  }
  async getPoolState(): Promise<PoolState> {
    throw new Error('unused')
  }
  async pendingFees() {
    return { quoteRaw: this.pendingRaw, baseRaw: 0n }
  }
  async claimFees(): Promise<ClaimResult> {
    this.claims++
    if (this.failNext) {
      const e = this.failNext
      this.failNext = null
      throw e
    }
    const total = this.pendingRaw
    const toPrizeRaw = (total * 7n) / 10n
    const toOpsRaw = total - toPrizeRaw
    const chain = this.s.memory!.chain
    chain.credit(this.s.prizeAddress, this.s.pumpMint, toPrizeRaw)
    chain.credit(this.s.opsAddress!, this.s.pumpMint, toOpsRaw)
    const slot = await chain.getSlot('confirmed')
    this.pendingRaw = 0n
    return {
      signatures: [`claim-${this.claims}`],
      claimedQuoteRaw: total,
      claimedBaseRaw: 0n,
      distributed: { toPrizeRaw, toOpsRaw, slot },
    }
  }
  async creatorLiquidityShare() {
    return 1
  }
}

let services: Services | null = null
let database: Database | null = null
afterEach(async () => {
  await services?.stop()
  await database?.close()
  services = null
  database = null
})

async function boot() {
  database = await freshDatabase()
  services = await buildServices(
    loadConfig({
      NODE_ENV: 'test',
      CHAIN_MODE: 'memory',
      ENGINE_ENABLED: 'false',
      SWEEPER_ENABLED: 'false',
      OPS_WALLET_ADDRESS: devAddress('ops'),
    }),
    { database },
  )
  const alerter = new TestAlerter()
  const venue = new FakeDirectVenue(services)
  const sweeper = new DirectFeeSweeper({
    db: database.db,
    venue,
    alerter,
    prizeAddress: services.prizeAddress,
    opsAddress: services.opsAddress!,
  })
  await services.reconciler.runOnce() // genesis deposit
  return { s: services, venue, sweeper, alerter, db: database.db }
}

describe('direct fee sweeper (venue pays the shares itself)', () => {
  it('claim → books sweep_in for exactly PRIZE’s share and marks the sweep done; the reconciler stays ok', async () => {
    const { s, venue, sweeper, alerter, db } = await boot()
    const prizeBefore = (await s.memory!.chain.getTokenBalance(s.prizeAddress, s.pumpMint)).value
    venue.pendingRaw = 1_000_000n
    const out = await sweeper.runOnce()
    expect(out.claimed?.status).toBe('done')
    expect(out.claimed?.claimedPumpRaw).toBe(1_000_000n)
    expect(out.claimed?.toPrizeRaw).toBe(700_000n)
    expect(out.claimed?.toOpsRaw).toBe(300_000n)
    expect(out.claimed?.txSigs).toEqual(['claim-1'])
    const ledger = await db.select().from(prizeLedger)
    expect(ledger.map((l) => [l.kind, l.amountRaw])).toEqual([
      ['deposit', prizeBefore],
      ['sweep_in', 700_000n],
    ])
    expect((await s.memory!.chain.getTokenBalance(s.opsAddress!, s.pumpMint)).value).toBe(300_000n)
    s.memory!.chain.advance(8)
    const r = await s.reconciler.runOnce()
    expect(r.status).toBe('ok') // the sweep_in explains the inflow exactly: nothing booked twice
    expect(s.pauses.first()).toBeNull()
    expect(alerter.events.map((e) => e.kind)).toEqual(['sweep.done'])
    // nothing pending → nothing happens
    expect((await sweeper.runOnce()).claimed).toBeNull()
    expect((await db.select().from(sweeps)).length).toBe(1)
  })

  it('a failed claim is recorded as failed and alerts; nothing is booked', async () => {
    const { venue, sweeper, alerter, db } = await boot()
    venue.pendingRaw = 5_000n
    venue.failNext = new Error('rpc down')
    const out = await sweeper.runOnce()
    expect(out.claimed).toBeNull()
    const [row] = await db.select().from(sweeps)
    expect(row!.status).toBe('failed')
    expect(row!.error).toMatch(/rpc down/)
    expect(alerter.events.map((e) => e.kind)).toEqual(['sweep.claim_failed'])
    expect((await db.select().from(prizeLedger)).map((l) => l.kind)).toEqual(['deposit'])
    // the fees are still there → the next run claims them
    const again = await sweeper.runOnce()
    expect(again.claimed?.status).toBe('done')
  })

  it('the reconciler waits while a claim is in flight, then books an interrupted claim as external_in', async () => {
    const { s, venue, sweeper, alerter, db } = await boot()
    // simulate a crash mid-claim: the row is 'claiming' and the PUMP already landed in PRIZE
    await db.insert(sweeps).values({ status: 'claiming' })
    s.memory!.chain.credit(s.prizeAddress, s.pumpMint, 42_000n)
    s.memory!.chain.advance(8)
    expect((await s.reconciler.runOnce()).status).toBe('waiting')
    expect((await db.select().from(prizeLedger)).map((l) => l.kind)).toEqual(['deposit'])
    // the sweeper's next run gives up on the interrupted row; the reconciler then books the inflow
    venue.pendingRaw = 0n
    await sweeper.runOnce()
    const [row] = await db.select().from(sweeps)
    expect(row!.status).toBe('failed')
    expect(alerter.events.map((e) => e.kind)).toEqual(['sweep.interrupted'])
    const r = await s.reconciler.runOnce()
    expect(r.status).toBe('booked_inflow')
    expect(r.deltaRaw).toBe(42_000n)
    expect(s.pauses.first()).toBeNull()
    expect((await db.select().from(sweeps).where(eq(sweeps.status, 'claiming'))).length).toBe(0)
  })

  it('a venue that claims without reporting the distribution is refused (nothing booked blindly)', async () => {
    const { venue, sweeper, db } = await boot()
    venue.pendingRaw = 10n
    venue.claimFees = async () => ({ signatures: ['x'], claimedQuoteRaw: 10n, claimedBaseRaw: 0n })
    await sweeper.runOnce()
    const [row] = await db.select().from(sweeps)
    expect(row!.status).toBe('failed')
    expect(row!.error).toMatch(/distributed/)
  })
})

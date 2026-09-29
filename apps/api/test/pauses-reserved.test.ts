import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AlertEvent, Alerter } from '../src/alerts/types'
import type { Database } from '../src/db/client'
import { reservedRaw } from '../src/db/queries'
import { jackpot, payouts } from '../src/db/schema'
import { PAUSE_SYNC_MS, PauseRegistry } from '../src/engine/pauses'
import { freshDatabase } from './helpers/db'

class TestAlerter implements Alerter {
  events: AlertEvent[] = []
  notify(e: AlertEvent) {
    this.events.push(e)
  }
  async flush() {}
}

let database: Database
beforeEach(async () => {
  database = await freshDatabase()
})
afterEach(async () => {
  await database.close()
})

describe('hard pauses are shared across processes (review EO-3 / PAUSE-2)', () => {
  it('a pause set by one process stops another within one sync interval, and a clear resumes it', async () => {
    const a = new PauseRegistry(database.db, new TestAlerter())
    const b = new PauseRegistry(database.db, new TestAlerter())
    await Promise.all([a.load(), b.load()])
    b.startSync()
    try {
      await a.set('invariant', 'unexplained outflow')
      expect(b.first()).toBeNull() // not yet synced
      await new Promise((r) => setTimeout(r, PAUSE_SYNC_MS + 400))
      expect(b.first()).toBe('invariant')
      await a.clear('invariant', 'reviewed')
      await new Promise((r) => setTimeout(r, PAUSE_SYNC_MS + 400))
      expect(b.first()).toBeNull()
    } finally {
      b.stopSync()
    }
  })

  it('a restart never silently resumes: pauses load from the database', async () => {
    const a = new PauseRegistry(database.db, new TestAlerter())
    await a.set('payouts_stuck', 'payout #7 failed simulation 10×')
    const restarted = new PauseRegistry(database.db, new TestAlerter())
    await restarted.load()
    expect(restarted.first()).toBe('payouts_stuck')
  })
})

describe('reservedRaw — liabilities at the same slot as the balance they are netted from (review SOL-4)', () => {
  it('counts unlanded prize payouts, and landed ones only if they landed after the balance slot', async () => {
    await database.db.insert(jackpot).values({ id: 1, amountRaw: 1_000n, seeded: true })
    await database.db.insert(payouts).values([
      { kind: 'tier', wallet: 'A', amountRaw: 100n, roundId: 1, status: 'queued' },
      { kind: 'tier', wallet: 'B', amountRaw: 10n, roundId: 1, status: 'held' },
      { kind: 'tier', wallet: 'C', amountRaw: 20n, roundId: 1, status: 'confirmed', landedSlot: 50n },
      { kind: 'tier', wallet: 'D', amountRaw: 7n, roundId: 1, status: 'failed_permanent' },
      {
        kind: 'sweep_prize',
        signer: 'creator',
        wallet: 'PRIZE',
        amountRaw: 5_000n,
        roundId: 0,
        status: 'queued',
      },
    ])
    expect(await reservedRaw(database.db)).toEqual({ jackpotRaw: 1_000n, outstandingRaw: 110n })
    // balance read at slot 40: C's transfer had not left the wallet yet → still reserved
    expect((await reservedRaw(database.db, 40)).outstandingRaw).toBe(130n)
    // balance read at slot 60: C is already out of the balance → not reserved twice
    expect((await reservedRaw(database.db, 60)).outstandingRaw).toBe(110n)
    expect((await reservedRaw(database.db, 50)).outstandingRaw).toBe(110n)
  })
})

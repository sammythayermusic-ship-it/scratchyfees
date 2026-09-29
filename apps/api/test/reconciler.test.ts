import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from '../src/db/client'
import { prizeLedger } from '../src/db/schema'
import { loadConfig } from '../src/env'
import { buildServices, devAddress, type Services } from '../src/services'
import { freshDatabase } from './helpers/db'

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
    loadConfig({ NODE_ENV: 'test', CHAIN_MODE: 'memory', ENGINE_ENABLED: 'false', SWEEPER_ENABLED: 'false' }),
    {
      database,
    },
  )
  return services
}

describe('ledger reconciler (invariant 2)', () => {
  it('opens the ledger with the genesis deposit, then stays ok', async () => {
    const s = await boot()
    expect((await s.reconciler.runOnce()).status).toBe('booked_inflow')
    expect((await s.reconciler.runOnce()).status).toBe('ok')
  })

  it('books a stranger’s dust / an operator top-up as an inflow and never pauses', async () => {
    const s = await boot()
    await s.reconciler.runOnce()
    s.memory!.chain.credit(s.prizeAddress, s.pumpMint, 12_345n)
    s.memory!.chain.advance(5) // let it finalize
    const r = await s.reconciler.runOnce()
    expect(r.status).toBe('booked_inflow')
    expect(r.deltaRaw).toBe(12_345n)
    expect(s.pauses.first()).toBeNull()
    const rows = await database!.db.select().from(prizeLedger)
    expect(rows.map((x) => x.kind).sort()).toEqual(['deposit', 'external_in'])
  })

  it('an unexplained outflow pauses payouts (invariant) after two consecutive observations', async () => {
    const s = await boot()
    await s.reconciler.runOnce()
    s.memory!.chain.transferExternal(s.prizeAddress, devAddress('thief'), s.pumpMint, 1_000_000n)
    s.memory!.chain.advance(5)
    expect((await s.reconciler.runOnce()).status).toBe('outflow_suspected')
    expect(s.pauses.first()).toBeNull()
    expect((await s.reconciler.runOnce()).status).toBe('paused')
    expect(s.pauses.first()).toBe('invariant')
  })
})

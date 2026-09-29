import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from '../src/db/client'
import { payouts } from '../src/db/schema'
import { loadConfig } from '../src/env'
import { buildServices, devAddress, type Services } from '../src/services'
import { freshDatabase } from './helpers/db'

let services: Services | null = null
let database: Database | null = null

afterEach(async () => {
  await services?.stop()
  await database?.close()
  services = null
})

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('composition root (memory mode)', () => {
  it('boots every service and pays a prize end to end through the live worker loop', async () => {
    database = await freshDatabase()
    services = await buildServices(
      loadConfig({ NODE_ENV: 'test', CHAIN_MODE: 'memory', SWEEPER_ENABLED: 'false' }),
      {
        database,
      },
    )
    expect(services.excludedWallets.has(services.prizeAddress)).toBe(true)
    services.start()
    await until(async () => services!.monitor.state().checkedAt) // first check opens the fail-closed gate
    expect(services.monitor.state().lowGas).toBe(false)
    expect(services.monitor.state().lowPool).toBe(false)

    const winner = devAddress('winner-1')
    const [p] = await database.db
      .insert(payouts)
      .values({ kind: 'tier', wallet: winner, amountRaw: 1_234_567n, roundId: 1, status: 'queued' })
      .returning()
    services.worker.wake()
    const done = await until(async () => {
      const [row] = await database!.db.select().from(payouts).where(eq(payouts.id, p!.id))
      return row?.status === 'confirmed' ? row : null
    })
    expect(done.txSig).toBeTruthy()
    expect((await services.chain.getTokenBalance(winner, services.pumpMint)).value).toBe(1_234_567n)
  })

  it('the dev faucet gives a pasted wallet deterministic holdings', async () => {
    database = await freshDatabase()
    services = await buildServices(
      loadConfig({ NODE_ENV: 'test', CHAIN_MODE: 'memory', SWEEPER_ENABLED: 'false' }),
      {
        database,
      },
    )
    const w = devAddress('player')
    await services.memory!.faucet(w)
    const bal = (await services.chain.getTokenBalance(w, services.scratchyMint)).value
    expect(bal).toBeGreaterThan(0n)
    await services.memory!.faucet(w)
    expect((await services.chain.getTokenBalance(w, services.scratchyMint)).value).toBe(bal)
  })
})

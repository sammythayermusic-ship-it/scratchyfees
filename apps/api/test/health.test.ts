import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import type { Database } from '../src/db/client'
import { loadConfig } from '../src/env'
import { buildServices, type Services } from '../src/services'
import { freshDatabase } from './helpers/db'

let services: Services | null = null
let database: Database | null = null
afterEach(async () => {
  await services?.stop()
  await database?.close()
  services = null
  database = null
})

describe('api scaffold', () => {
  it('serves /health', async () => {
    database = await freshDatabase()
    services = await buildServices(
      loadConfig({ NODE_ENV: 'test', ENGINE_ENABLED: 'false', SWEEPER_ENABLED: 'false' }),
      { database },
    )
    const app = await buildApp(services)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, cluster: 'memory', chain: 'memory' })
    await app.close()
  })

  it('refuses mainnet unless armed, and only with the real PUMP mint on solana', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', SOLANA_CLUSTER: 'mainnet-beta' })).toThrow(/ALLOW_MAINNET/)
    expect(() =>
      loadConfig({ NODE_ENV: 'test', SOLANA_CLUSTER: 'mainnet-beta', ALLOW_MAINNET: 'yes' }),
    ).toThrow(/CHAIN_MODE=solana/)
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        SOLANA_CLUSTER: 'mainnet-beta',
        ALLOW_MAINNET: 'yes',
        CHAIN_MODE: 'solana',
        PUMP_MINT: 'Mock111',
      }),
    ).toThrow(/real PUMP/)
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        SOLANA_CLUSTER: 'mainnet-beta',
        ALLOW_MAINNET: 'yes',
        CHAIN_MODE: 'solana',
      }),
    ).toThrow(/PRICE_SOURCE=live/)
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        SOLANA_CLUSTER: 'mainnet-beta',
        ALLOW_MAINNET: 'yes',
        CHAIN_MODE: 'solana',
        PRICE_SOURCE: 'live',
      }),
    ).not.toThrow()
  })

  it('production never runs on the in-memory chain', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', CHAIN_MODE: 'memory' })).toThrow(/CHAIN_MODE=solana/)
  })

  it('rejects an out-of-range PAYOUT_RATE', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', PAYOUT_RATE: '0.02' })).toThrow(/0.3%–0.8%/)
  })
})

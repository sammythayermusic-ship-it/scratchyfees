import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import { loadConfig } from '../src/env'

describe('api scaffold', () => {
  it('serves /health', async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: 'test' }))
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, cluster: 'devnet', chain: 'memory' })
    await app.close()
  })

  it('refuses mainnet unless armed', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', SOLANA_CLUSTER: 'mainnet-beta' })).toThrow(/ALLOW_MAINNET/)
    expect(() =>
      loadConfig({ NODE_ENV: 'test', SOLANA_CLUSTER: 'mainnet-beta', ALLOW_MAINNET: 'yes' }),
    ).not.toThrow()
  })

  it('rejects an out-of-range PAYOUT_RATE', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', PAYOUT_RATE: '0.02' })).toThrow(/0.3%–0.8%/)
  })
})

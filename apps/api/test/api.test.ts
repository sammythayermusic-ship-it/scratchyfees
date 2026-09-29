import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app'
import { activity, jackpot, payouts } from '../src/db/schema'
import type { Database } from '../src/db/client'
import { loadConfig } from '../src/env'
import { buildServices, devAddress, type Services } from '../src/services'
import type { FastifyInstance } from 'fastify'
import { freshDatabase } from './helpers/db'

const ADMIN = 'a'.repeat(40)
const S1 = 'session-aaaaaaaaaaaaaaaa'
const S2 = 'session-bbbbbbbbbbbbbbbb'
let clock = Date.parse('2026-09-29T12:00:05Z')
let services: Services | null = null
let database: Database | null = null
let app: FastifyInstance | null = null

async function boot(extra: Record<string, string> = {}) {
  clock = Date.parse('2026-09-29T12:00:05Z')
  database = await freshDatabase()
  services = await buildServices(
    loadConfig({
      NODE_ENV: 'test',
      CHAIN_MODE: 'memory',
      ENGINE_ENABLED: 'false',
      SWEEPER_ENABLED: 'false',
      ROUND_SECONDS: '60',
      ADMIN_TOKEN: ADMIN,
      ...extra,
    }),
    { database, now: () => new Date(clock) },
  )
  await services.oracle.get()
  services.monitor.start()
  for (let i = 0; i < 100 && !services.monitor.state().checkedAt; i++)
    await new Promise((r) => setTimeout(r, 50))
  expect(services.monitor.state().lowPool).toBe(false)
  app = await buildApp(services)
  return { s: services, app }
}

afterEach(async () => {
  await app?.close()
  await services?.stop()
  await database?.close()
  app = null
  services = null
})

const post = (url: string, body: unknown, session = S1) =>
  app!.inject({ method: 'POST', url, payload: body as object, headers: { 'x-scratchy-session': session } })

describe('HTTP API', () => {
  it('RPC trouble on /api/enter → clean 503 (no provider details), and the wallet is still entered for the next drop', async () => {
    const { s } = await boot()
    const w = devAddress('rpc-down')
    s.memory!.chain.faults.rpcDown = true
    const res = await post('/api/enter', { wallet: w })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({
      error: 'chain_busy',
      message: 'The Solana network is busy — try again in a few seconds.',
    })
    expect(res.headers['retry-after']).toBe('3')
    const rows = await database!.db.select().from(activity).where(eq(activity.wallet, w))
    expect(rows).toHaveLength(1)
    s.memory!.chain.faults.rpcDown = false
  })

  it('enter → drop → scratch → payout → winners → fair, end to end', async () => {
    const { s } = await boot()
    await s.engine.tick()
    const wallet = devAddress('api-player')

    expect((await app!.inject({ method: 'POST', url: '/api/enter', payload: { wallet } })).statusCode).toBe(
      400,
    ) // no session
    expect((await post('/api/enter', { wallet: 'nope' })).json().error).toBe('invalid_wallet')
    const first = await post('/api/enter', { wallet, x_handle: 'scratchyfan' })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ wallet, xHandle: 'scratchyfan', eligibleNow: true, entry: null })

    clock += 60_000
    await s.engine.tick() // next drop: the wallet was active last round (Decision C)
    const entered = (await post('/api/enter', { wallet })).json()
    expect(entered.entry.tickets.length).toBe(entered.ticketsPerDrop)
    expect(entered.locked).toBe(false)

    const round = (await app!.inject({ method: 'GET', url: `/api/round?wallet=${wallet}` })).json()
    expect(round.round.status).toBe('live')
    expect(round.you.ticketsRemaining).toBe(entered.entry.tickets.length)
    expect(round.nextRound.seedHash).toMatch(/^[0-9a-f]{64}$/)

    // a second tab can't scratch
    const other = (await post('/api/enter', { wallet }, S2)).json()
    expect(other.locked).toBe(true)
    const ids = entered.entry.tickets.map((t: { id: string }) => t.id)
    expect((await post('/api/scratch', { ticket_ids: ids, wallet }, S2)).statusCode).toBe(423)

    const res = await post('/api/scratch', { ticket_ids: ids, wallet })
    expect(res.statusCode).toBe(200)
    const outcomes = res.json().outcomes as { tier: number; payoutId: string | null; prizeRaw: string }[]
    expect(outcomes).toHaveLength(ids.length)
    const win = outcomes.find((o) => o.payoutId)
    if (win) {
      const p = (await app!.inject({ method: 'GET', url: `/api/payout/${win.payoutId}` })).json()
      expect(['queued', 'sending', 'confirmed']).toContain(p.status)
      const winners = (await app!.inject({ method: 'GET', url: '/api/winners' })).json()
      expect(winners.recent.length).toBeGreaterThan(0)
      expect(winners.recent[0].xHandle).toBe('scratchyfan')
    }

    // fairness: nothing revealed while live
    const fairLive = (await app!.inject({ method: 'GET', url: `/api/fair/${round.round.id}` })).json()
    expect(fairLive.round.serverSeed).toBeNull()
    expect(
      (await app!.inject({ method: 'GET', url: `/api/fair/${round.round.id}/tickets?wallet=${wallet}` }))
        .statusCode,
    ).toBe(409)
    clock += 60_000
    await s.engine.tick()
    const fairEnded = (await app!.inject({ method: 'GET', url: `/api/fair/${round.round.id}` })).json()
    expect(fairEnded.round.serverSeed).toMatch(/^[0-9a-f]{64}$/)
    const ts = (
      await app!.inject({ method: 'GET', url: `/api/fair/${round.round.id}/tickets?wallet=${wallet}` })
    ).json()
    expect(ts.tickets).toHaveLength(ids.length)

    const stats = (await app!.inject({ method: 'GET', url: '/api/stats' })).json()
    expect(stats.poolHistory.length).toBeGreaterThan(0)
  })

  it('admin: token required; pause/resume; PAYOUT_RATE validated to 0.3–0.8%', async () => {
    await boot()
    expect((await app!.inject({ method: 'GET', url: '/api/admin/status' })).statusCode).toBe(401)
    const auth = { authorization: `Bearer ${ADMIN}` }
    expect(
      (
        await app!.inject({
          method: 'GET',
          url: '/api/admin/status',
          headers: { authorization: 'Bearer wrong' },
        })
      ).statusCode,
    ).toBe(401)
    const st = await app!.inject({ method: 'GET', url: '/api/admin/status', headers: auth })
    expect(st.statusCode).toBe(200)
    expect(st.json().payoutRate.effective).toBe('0.005')
    await app!.inject({ method: 'POST', url: '/api/admin/pause', headers: auth, payload: { note: 'test' } })
    expect((await app!.inject({ method: 'GET', url: '/health' })).json().paused).toBe('manual')
    const noNote = await app!.inject({
      method: 'POST',
      url: '/api/admin/resume',
      headers: auth,
      payload: { reason: 'manual' },
    })
    expect(noNote.statusCode).toBe(400) // every admin action needs a note (audit trail)
    await app!.inject({
      method: 'POST',
      url: '/api/admin/resume',
      headers: auth,
      payload: { reason: 'manual', note: 'drill over' },
    })
    expect((await app!.inject({ method: 'GET', url: '/health' })).json().paused).toBeNull()
    const st2 = (await app!.inject({ method: 'GET', url: '/api/admin/status', headers: auth })).json()
    expect(st2.events.some((e: { kind: string }) => e.kind === 'resume.manual')).toBe(true)
    expect(st2.thresholds.minGasSol).toBeTruthy()
    expect(st2.mint.accepted === null || typeof st2.mint.accepted === 'string').toBe(true)
    expect(
      (
        await app!.inject({
          method: 'POST',
          url: '/api/admin/payout-rate',
          headers: auth,
          payload: { rate: '0.02' },
        })
      ).statusCode,
    ).toBe(400)
    const ok = await app!.inject({
      method: 'POST',
      url: '/api/admin/payout-rate',
      headers: auth,
      payload: { rate: '0.006' },
    })
    expect(ok.json()).toMatchObject({ ok: true, payoutRate: '0.006' })
  })

  it('admin retry of a permanently failed JACKPOT takes the amount back out of the pot (never owed twice)', async () => {
    await boot()
    const auth = { authorization: `Bearer ${ADMIN}` }
    const db = database!.db
    await db.insert(jackpot).values({ id: 1, amountRaw: 1_000n, seeded: true }) // includes a returned 400
    const [a] = await db
      .insert(payouts)
      .values({
        kind: 'jackpot',
        wallet: devAddress('jp-a'),
        amountRaw: 400n,
        roundId: 1,
        status: 'failed_permanent',
      })
      .returning()
    const [b] = await db
      .insert(payouts)
      .values({
        kind: 'jackpot',
        wallet: devAddress('jp-b'),
        amountRaw: 700n,
        roundId: 2,
        status: 'failed_permanent',
      })
      .returning()
    const retry = (id: bigint, note?: string) =>
      app!.inject({
        method: 'POST',
        url: `/api/admin/payouts/${id}/retry`,
        headers: auth,
        payload: note ? { note } : {},
      })
    expect((await retry(a!.id)).statusCode).toBe(400) // note required
    const ok = await retry(a!.id, 'account unfrozen')
    expect(ok.statusCode).toBe(200)
    expect((await db.select().from(jackpot))[0]!.amountRaw).toBe(600n)
    const short = await retry(b!.id, 'try again')
    expect(short.statusCode).toBe(409)
    expect(short.json().error).toBe('pot_short')
    expect((await db.select().from(payouts).where(eq(payouts.id, b!.id)))[0]!.status).toBe('failed_permanent')
  })

  it('rate limits /api/enter per IP', async () => {
    await boot({ RATE_LIMIT_ENTER_PER_MIN: '3' })
    const codes: number[] = []
    for (let i = 0; i < 5; i++)
      codes.push((await post('/api/enter', { wallet: devAddress('rl') })).statusCode)
    expect(codes.slice(0, 3).every((c) => c === 200)).toBe(true)
    expect(codes.at(-1)).toBe(429)
  })

  it('CORS allows only the configured origins', async () => {
    await boot({ CORS_ORIGINS: 'https://scratchyfees.fun' })
    const good = await app!.inject({
      method: 'GET',
      url: '/api/round',
      headers: { origin: 'https://scratchyfees.fun' },
    })
    expect(good.headers['access-control-allow-origin']).toBe('https://scratchyfees.fun')
    const bad = await app!.inject({
      method: 'GET',
      url: '/api/round',
      headers: { origin: 'https://evil.example' },
    })
    expect(bad.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('websocket: hello → snapshot; foreign origins are refused', async () => {
    await boot({ CORS_ORIGINS: 'https://scratchyfees.fun' })
    await app!.ready()
    const ws = await app!.injectWS('/ws', { headers: { origin: 'https://scratchyfees.fun' } })
    const snap = new Promise<Record<string, unknown>>((res) =>
      ws.on('message', (m: Buffer) => res(JSON.parse(m.toString()))),
    )
    ws.send(JSON.stringify({ type: 'hello', session: S1 }))
    expect((await snap).type).toBe('snapshot')
    ws.terminate()
    const evil = await app!.injectWS('/ws', { headers: { origin: 'https://evil.example' } })
    const closed = await new Promise<number>((res) => evil.on('close', (code: number) => res(code)))
    expect(closed).toBe(1008)
  })
})

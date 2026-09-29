import type { FastifyInstance } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import { normalizeWalletAddress } from '../chain/address'
import type { EngineEvent } from '../engine/events'
import type { Services } from '../services'
import { clientIp, isValidSession } from './http'
import { roundSnapshot } from './public'

/**
 * GET /ws — one channel pushing pool, jackpot meter, countdown and winner events to every client (PLAN §3),
 * plus per-wallet payout status to the sockets watching that wallet.
 *   client → {type:'hello', session, wallet?} · {type:'hb', wallet?, visible} (every ~20 s) · {type:'watch', wallet}
 *   server → snapshot · tick (5 s) · drop · round_end · winner · jackpot (global banner) · payout · void
 * CORS doesn't apply to websockets, so the Origin header is checked against the same allowlist.
 */

interface Client {
  socket: WebSocket
  session: string | null
  wallet: string | null
  msgs: number
  windowStart: number
}

export async function registerWs(app: FastifyInstance, s: Services, allowedOrigins: string[]) {
  const clients = new Set<Client>()
  const perIp = new Map<string, number>()
  const trustCloudflare = s.config.env.TRUST_CLOUDFLARE
  const send = (c: Client, msg: unknown) => {
    if (c.socket.readyState === 1) c.socket.send(JSON.stringify(msg))
  }

  s.bus.on((e: EngineEvent) => {
    for (const c of clients) {
      if (e.type === 'payout') {
        // a confirmed PRIZE payout is public on-chain anyway: everyone gets it (the winners feed flips to "paid");
        // every intermediate status goes only to the sockets watching that wallet
        const publicConfirm = e.status === 'confirmed' && (e.kind === 'tier' || e.kind === 'jackpot')
        if (publicConfirm || c.wallet === e.wallet) send(c, e)
      } else if (e.type === 'void') {
        if (c.wallet === e.wallet) send(c, e)
      } else send(c, e)
    }
  })

  const tick = setInterval(async () => {
    if (clients.size === 0) return
    try {
      const snap = await roundSnapshot(s)
      const msg = {
        type: 'tick',
        serverTime: snap.serverTime,
        pool: snap.pool,
        prices: snap.prices,
        paused: snap.paused,
        round: snap.round,
      }
      for (const c of clients) send(c, msg)
    } catch {
      /* next tick */
    }
  }, 5_000)
  tick.unref()
  app.addHook('onClose', async () => clearInterval(tick))

  app.get('/ws', { websocket: true }, (socket, req) => {
    const origin = req.headers.origin
    if (origin && !allowedOrigins.includes(origin)) {
      socket.close(1008, 'origin not allowed')
      return
    }
    // per-IP socket cap (security review #6): each connection costs a snapshot + a slot in the fan-out
    const ip = clientIp(req, trustCloudflare)
    const open = perIp.get(ip) ?? 0
    if (open >= 8) {
      socket.close(1013, 'too many connections')
      return
    }
    perIp.set(ip, open + 1)
    const c: Client = { socket, session: null, wallet: null, msgs: 0, windowStart: Date.now() }
    clients.add(c)
    socket.on('close', () => {
      clients.delete(c)
      const n = (perIp.get(ip) ?? 1) - 1
      if (n <= 0) perIp.delete(ip)
      else perIp.set(ip, n)
    })
    socket.on('message', async (buf: Buffer) => {
      const now = Date.now()
      if (now - c.windowStart > 10_000) {
        c.windowStart = now
        c.msgs = 0
      }
      if (++c.msgs > 30 || buf.length > 2_048) {
        socket.close(1008, 'too chatty')
        return
      }
      let m: { type?: string; session?: unknown; wallet?: unknown; visible?: unknown }
      try {
        m = JSON.parse(buf.toString())
      } catch {
        return
      }
      if (m.type === 'hello' || m.type === 'watch') {
        if (isValidSession(m.session)) c.session = m.session
        c.wallet = normalizeWalletAddress(m.wallet)
        if (m.type === 'hello') send(c, { type: 'snapshot', ...(await roundSnapshot(s, c.wallet)) })
      } else if (m.type === 'hb' && m.visible === true && c.session) {
        const w = normalizeWalletAddress(m.wallet) ?? c.wallet
        if (w) await s.entries.heartbeat(c.session, w).catch(() => {})
      }
    })
  })
}

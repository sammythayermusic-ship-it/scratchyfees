import type { FastifyInstance } from 'fastify'
import { normalizeWalletAddress } from '../chain/address'
import type { Services } from '../services'
import { clientIp, fail, KeyedLimiter, sessionId } from './http'

/**
 * POST /api/enter and POST /api/scratch (PLAN §3.2). Limits: per IP (@fastify/rate-limit, route config) and
 * per (IP, wallet) here. There is deliberately NO global per-wallet bucket: the wallet is whatever the client
 * sends, so a shared bucket lets anyone exhaust a victim's quota and lock them out (security review #2).
 * SCRATCH ALL is a single request carrying up to 100 ticket ids and costs one unit.
 */
export async function registerPlayRoutes(app: FastifyInstance, s: Services) {
  const env = s.config.env
  const perIpWallet = new KeyedLimiter(env.RATE_LIMIT_WALLET_PER_MIN)

  app.post(
    '/api/enter',
    { config: { rateLimit: { max: env.RATE_LIMIT_ENTER_PER_MIN, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const session = sessionId(req)
      if (!session) return fail(reply, 400, 'bad_session', 'missing x-scratchy-session header')
      const body = (req.body ?? {}) as { wallet?: unknown; x_handle?: unknown }
      const ip = clientIp(req, env.TRUST_CLOUDFLARE)
      const wallet = normalizeWalletAddress(body.wallet)
      if (wallet && !perIpWallet.take(`${ip}|${wallet}`)) {
        return fail(reply, 429, 'rate_limited', 'slow down a little')
      }
      const res = await s.entries.enter({
        wallet: body.wallet,
        xHandle: body.x_handle,
        sessionId: session,
        ip,
      })
      if ('error' in res)
        return fail(reply, res.error === 'too_many_wallets' ? 429 : 400, res.error, res.message)
      return res
    },
  )

  app.post(
    '/api/scratch',
    { config: { rateLimit: { max: env.RATE_LIMIT_SCRATCH_PER_MIN, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const session = sessionId(req)
      if (!session) return fail(reply, 400, 'bad_session', 'missing x-scratchy-session header')
      const body = (req.body ?? {}) as { ticket_id?: unknown; ticket_ids?: unknown; wallet?: unknown }
      const rawIds = Array.isArray(body.ticket_ids)
        ? body.ticket_ids
        : body.ticket_id !== undefined
          ? [body.ticket_id]
          : []
      const ids: bigint[] = []
      for (const r of rawIds) {
        if ((typeof r !== 'string' && typeof r !== 'number') || !/^\d{1,19}$/.test(String(r))) {
          return fail(reply, 400, 'bad_request', 'ticket ids must be numeric strings')
        }
        ids.push(BigInt(r))
      }
      const ip = clientIp(req, env.TRUST_CLOUDFLARE)
      const wallet = normalizeWalletAddress(body.wallet)
      if (wallet && !perIpWallet.take(`${ip}|${wallet}`)) {
        return fail(reply, 429, 'rate_limited', 'slow down a little')
      }
      const res = await s.scratch.scratch(session, ids)
      if (!res.ok) {
        const status = {
          not_found: 404,
          not_live: 409,
          not_entered: 404,
          voided: 409,
          bad_request: 400,
        }[res.error]
        return fail(reply, status, res.error, res.message)
      }
      return res
    },
  )
}

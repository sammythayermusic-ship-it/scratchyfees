import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { TransientChainError } from './chain/types'
import { registerAdminRoutes } from './routes/admin'
import { clientIp } from './routes/http'
import { registerPlayRoutes } from './routes/play'
import { registerPublicRoutes } from './routes/public'
import { registerWs } from './routes/ws'
import type { Services } from './services'

/** Build the Fastify app around already-built services (no listen) — used by main.ts and by tests. */
export async function buildApp(services: Services): Promise<FastifyInstance> {
  const { env } = services.config
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL, redact: ['req.headers.authorization'] },
    bodyLimit: 16 * 1024,
    trustProxy: env.TRUST_CLOUDFLARE,
  })

  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type', 'x-scratchy-session', 'authorization'],
  })
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => clientIp(req, env.TRUST_CLOUDFLARE),
  })
  await app.register(websocket, { options: { maxPayload: 4_096 } })

  // never leak internals (RPC URLs/keys in provider errors, stack traces); RPC trouble is a retryable 503
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof TransientChainError) {
      req.log.warn({ err: err.message }, 'transient chain error')
      return reply
        .status(503)
        .header('retry-after', '3')
        .send({ error: 'chain_busy', message: 'The Solana network is busy — try again in a few seconds.' })
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: err.code ?? 'bad_request', message: err.message })
    }
    req.log.error(err)
    return reply
      .status(500)
      .send({ error: 'internal', message: 'Something went wrong on our side — try again.' })
  })

  app.get('/health', async () => ({
    ok: true,
    cluster: env.CHAIN_MODE === 'memory' ? 'memory' : env.SOLANA_CLUSTER,
    chain: env.CHAIN_MODE,
    paused: services.pauses.first(),
  }))

  await registerPublicRoutes(app, services)
  await registerPlayRoutes(app, services)
  await registerAdminRoutes(app, services)
  await registerWs(app, services, env.CORS_ORIGINS)
  return app
}

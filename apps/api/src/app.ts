import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppConfig } from './env'

/** Build the Fastify app (no listen) — used by main.ts and by tests via app.inject(). */
export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const { env } = config
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
    trustProxy: env.TRUST_CLOUDFLARE,
  })

  await app.register(cors, { origin: env.CORS_ORIGINS, credentials: false })

  app.get('/health', async () => ({ ok: true, cluster: env.SOLANA_CLUSTER, chain: env.CHAIN_MODE }))

  return app
}

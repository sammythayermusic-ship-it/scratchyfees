import { timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

/** Shared HTTP helpers: client identity, sessions, per-key rate limiting, admin auth, bigint-safe JSON. */

const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/

/** Real client IP: Cloudflare's CF-Connecting-IP only when explicitly trusted (origin firewalled to CF). */
export function clientIp(req: FastifyRequest, trustCloudflare: boolean): string {
  if (trustCloudflare) {
    const cf = req.headers['cf-connecting-ip']
    if (typeof cf === 'string' && cf.length > 0 && cf.length < 64) return cf
  }
  return req.ip
}

/** Client-generated session id (random, stored in the browser) — identifies a tab for the scratch lock. */
export function sessionId(req: FastifyRequest): string | null {
  const s = req.headers['x-scratchy-session']
  return typeof s === 'string' && SESSION_RE.test(s) ? s : null
}

export function isValidSession(s: unknown): s is string {
  return typeof s === 'string' && SESSION_RE.test(s)
}

/** Fixed-window per-key limiter (per wallet, per IP+wallet). In-memory: one API process per deployment. */
export class KeyedLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limitPerWindow: number,
    private readonly windowMs = 60_000,
  ) {}

  /** true when allowed; consumes `cost` */
  take(key: string, cost = 1, now = Date.now()): boolean {
    const cur = this.hits.get(key)
    if (!cur || cur.resetAt <= now) {
      if (this.hits.size > 50_000) this.sweep(now)
      this.hits.set(key, { count: cost, resetAt: now + this.windowMs })
      return cost <= this.limitPerWindow
    }
    cur.count += cost
    return cur.count <= this.limitPerWindow
  }

  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k)
  }
}

export function adminAuthorized(req: FastifyRequest, token: string | undefined): boolean {
  if (!token) return false
  const h = req.headers.authorization
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return false
  const given = Buffer.from(h.slice(7))
  const want = Buffer.from(token)
  return given.length === want.length && timingSafeEqual(given, want)
}

export function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.status(status).send({ error, message })
}

/** JSON.stringify replacer: bigints → decimal strings, Dates → ISO. */
export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

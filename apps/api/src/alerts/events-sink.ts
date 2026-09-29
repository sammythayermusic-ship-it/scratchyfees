import type { Db } from '../db/client'
import { events } from '../db/schema'
import type { AlertEvent, Severity } from './types'

/**
 * The durable half of ops alerting (PLAN §5: "every payout, sweep, and breaker event logs to Postgres
 * AND a Telegram bot channel"). The alerter writes every event here first — before dedupe, digesting or
 * any Telegram delivery — so the `events` table is the complete record even when Telegram is down,
 * rate-limited or not configured.
 *
 * This module also owns the event sanitizer every alert passes through before it reaches Postgres,
 * logs or Telegram:
 *  - data is made JSON-safe (bigint → decimal string, Date → ISO, byte arrays are never serialized);
 *  - anything that looks like secret material is redacted: long base58/hex/base64 runs (a 64-byte
 *    keypair is 87–88 base58 chars), JSON byte arrays (`[12,34,…]`, 32+ bytes), Buffer dumps,
 *    Telegram bot tokens, values under secret-looking keys, and any exact secret the caller passes
 *    (the configured bot token).
 */

export interface EventsSink {
  /** persist one (already sanitized) event; may reject — the alerter logs and swallows failures */
  write(event: AlertEvent): Promise<void>
}

/** Inserts into the `events` table (kind, severity, message, data jsonb). */
export class DbEventsSink implements EventsSink {
  constructor(private readonly db: Db) {}

  async write(event: AlertEvent): Promise<void> {
    // defensive: the alerter already sanitized, but a direct caller must never persist secrets/bigints
    const e = sanitizeEvent(event)
    await this.db.insert(events).values({
      kind: e.kind,
      severity: e.severity,
      message: e.message,
      data: e.data ?? null,
    })
  }
}

/** Discards everything (tests / tools that don't need an ops log). */
export class NullEventsSink implements EventsSink {
  async write(): Promise<void> {}
}

/** Keeps events in memory (tests, `CHAIN_MODE=memory` dev without a database). */
export class MemoryEventsSink implements EventsSink {
  readonly events: AlertEvent[] = []
  constructor(private readonly limit = 10_000) {}

  async write(event: AlertEvent): Promise<void> {
    this.events.push(sanitizeEvent(event))
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit)
  }
}

// ── sanitizing ───────────────────────────────────────────────────────────────

export const REDACTED = '[REDACTED]'

const SEVERITIES: ReadonlySet<string> = new Set<Severity>(['info', 'warn', 'critical'])
const MAX_KIND_CHARS = 120
const MAX_MESSAGE_CHARS = 8_000
const MAX_STRING_CHARS = 2_000
const MAX_DEPTH = 6
const MAX_ARRAY_ITEMS = 200
const MAX_OBJECT_KEYS = 100

/** Keys whose values are never persisted, whatever they look like. */
const SECRET_KEY_NAME =
  /(secret|private|mnemonic|passw(or)?d|passphrase|api[-_]?key|(bot|auth|access|refresh)[-_]?token|keypair|wallet[-_]?key|server[-_]?seed$)/i

const TEXT_PATTERNS: RegExp[] = [
  // Telegram bot tokens (any bot, not only ours): 123456789:AA…
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}/g,
  // JSON / JS byte arrays of 32+ small integers — the Solana CLI keypair file format is one of these
  /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*,?\s*\]/g,
  // Node Buffer / hex dumps: 16+ space- or colon-separated byte pairs
  /(?:\b[0-9a-fA-F]{2}[\s:,]){15,}[0-9a-fA-F]{2}\b/g,
  // long hex (a 32-byte seed is 64 hex chars)
  /(?:0x)?[0-9a-fA-F]{64,}/g,
  // long base58 (a 64-byte keypair / secret key is 87–88 chars)
  /[1-9A-HJ-NP-Za-km-z]{64,}/g,
  // long base64 / base64url
  /[A-Za-z0-9+/_-]{80,}={0,2}/g,
]

/** Redact secret-looking material from free text. `secrets` are exact strings (e.g. the bot token). */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join(REDACTED)
  }
  for (const re of TEXT_PATTERNS) out = out.replace(re, REDACTED)
  return out
}

/** Make any value JSON-serializable without ever emitting raw bytes. Pure; never throws on odd input. */
export function toJsonSafe(value: unknown): unknown {
  return jsonSafe(value, 0, [])
}

function jsonSafe(value: unknown, depth: number, ancestors: object[]): unknown {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'bigint':
      return value.toString()
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'string':
      return value
    case 'boolean':
      return value
    case 'function':
    case 'symbol':
      return undefined
  }
  const obj = value as object
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString()
  // raw bytes are never serialized (a Keypair's secretKey is a Uint8Array)
  if (ArrayBuffer.isView(obj)) return `[${obj.byteLength} bytes]`
  if (obj instanceof ArrayBuffer) return `[${obj.byteLength} bytes]`
  if (obj instanceof Error) return { name: obj.name, message: obj.message }
  if (depth >= MAX_DEPTH) return '[…]'
  if (ancestors.includes(obj)) return '[circular]'
  ancestors.push(obj)
  try {
    if (Array.isArray(obj)) {
      const items = obj.slice(0, MAX_ARRAY_ITEMS).map((v) => jsonSafe(v, depth + 1, ancestors) ?? null)
      if (obj.length > MAX_ARRAY_ITEMS) items.push(`…${obj.length - MAX_ARRAY_ITEMS} more`)
      return items
    }
    if (obj instanceof Set) return jsonSafe([...obj], depth, ancestors)
    if (obj instanceof Map) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of obj) {
        const safe = jsonSafe(v, depth + 1, ancestors)
        if (safe !== undefined) out[String(k)] = safe
      }
      return out
    }
    const withBase58 = obj as { toBase58?: unknown }
    if (typeof withBase58.toBase58 === 'function') return String((withBase58.toBase58 as () => unknown)())
    const withJson = obj as { toJSON?: unknown }
    if (typeof withJson.toJSON === 'function') {
      return jsonSafe((withJson.toJSON as () => unknown).call(obj), depth + 1, ancestors)
    }
    const out: Record<string, unknown> = {}
    let n = 0
    for (const [k, v] of Object.entries(obj)) {
      if (++n > MAX_OBJECT_KEYS) {
        out['…'] = `${Object.keys(obj).length - MAX_OBJECT_KEYS} more keys`
        break
      }
      const safe = jsonSafe(v, depth + 1, ancestors)
      if (safe !== undefined) out[k] = safe
    }
    return out
  } finally {
    ancestors.pop()
  }
}

function isByteArray(v: unknown[]): boolean {
  return v.length >= 32 && v.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 255)
}

/** Redact a JSON-safe value (output of toJsonSafe) recursively; long strings are cut AFTER redaction. */
export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    const r = redactText(value, secrets)
    return r.length > MAX_STRING_CHARS ? `${r.slice(0, MAX_STRING_CHARS)}…` : r
  }
  if (Array.isArray(value)) return isByteArray(value) ? REDACTED : value.map((v) => redactValue(v, secrets))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_NAME.test(k) && v !== null && typeof v !== 'boolean' ? REDACTED : redactValue(v, secrets)
    }
    return out
  }
  return value
}

/** JSON-safe + redacted copy of an alert's data (always a plain object, or undefined). */
export function sanitizeData(
  data: Record<string, unknown> | undefined,
  secrets: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (data === undefined || data === null) return undefined
  const safe = redactValue(toJsonSafe(data), secrets)
  if (safe !== null && typeof safe === 'object' && !Array.isArray(safe)) return safe as Record<string, unknown>
  return { value: safe }
}

/** The copy of an event that may be persisted, logged and sent. Idempotent. Never throws. */
export function sanitizeEvent(event: AlertEvent, secrets: readonly string[] = []): AlertEvent {
  const kind = redactText(String(event.kind ?? 'unknown'), secrets).slice(0, MAX_KIND_CHARS) || 'unknown'
  const severity: Severity = SEVERITIES.has(event.severity) ? event.severity : 'warn'
  let message = redactText(String(event.message ?? ''), secrets)
  if (message.length > MAX_MESSAGE_CHARS) message = `${message.slice(0, MAX_MESSAGE_CHARS)}…`
  const out: AlertEvent = { kind, severity, message }
  const data = sanitizeData(event.data, secrets)
  if (data !== undefined) out.data = data
  if (event.immediate) out.immediate = true
  if (event.dedupeKey) out.dedupeKey = redactText(String(event.dedupeKey), secrets).slice(0, MAX_KIND_CHARS)
  return out
}

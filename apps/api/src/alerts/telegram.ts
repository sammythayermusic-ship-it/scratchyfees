import { formatPumpCompact } from '@scratchy/core'
import { redactText, sanitizeEvent, type EventsSink } from './events-sink'
import type { AlertEvent, Alerter, Severity } from './types'

/**
 * Ops alerter (PLAN §5): every event goes to Postgres (the EventsSink) AND a structured log line, then
 * — when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set — to a Telegram chat:
 *  - `immediate` events (big wins, jackpots, failures, breaker, pauses) are queued for sending at once;
 *  - everything else accumulates into one digest per TELEGRAM_DIGEST_SECONDS ("🎫 12 payouts confirmed:
 *    3.2M PUMP total", per-kind counts + up to 10 lines);
 *  - sends are paced to ≤ 1 message/second and ≤ 18 messages/minute for the chat (under Telegram's
 *    per-chat limits); whatever is queued when a slot opens is merged into that one message;
 *  - `dedupeKey` suppresses a repeat of the same key (same kind + severity) for 10 minutes on Telegram
 *    only — the sink and log still get every event; a change under the key (paused → resumed,
 *    warn → critical) always goes through;
 *  - a failed send is logged and retried once (honouring 429 retry_after; a 400 retries as plain text),
 *    then dropped — it is already in Postgres.
 * notify() is synchronous and never throws. Secret-looking material (see events-sink.ts) and the bot
 * token itself are redacted before anything is persisted, logged or sent.
 */

/** pino / Fastify-logger compatible subset: `log.info({…}, 'msg')` */
export interface AlertLogger {
  info(obj: Record<string, unknown>, msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

type LogLevel = keyof AlertLogger

function writeJsonLine(level: LogLevel, obj: Record<string, unknown>, msg: string): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...obj })
  if (level === 'info') process.stdout.write(`${line}\n`)
  else process.stderr.write(`${line}\n`)
}

/** Default logger: one JSON line per event (stdout for info, stderr for warn/error). */
export const jsonLineLogger: AlertLogger = {
  info: (obj, msg) => writeJsonLine('info', obj, msg),
  warn: (obj, msg) => writeJsonLine('warn', obj, msg),
  error: (obj, msg) => writeJsonLine('error', obj, msg),
}

export const DEDUPE_WINDOW_MS = 10 * 60_000
export const MIN_SEND_INTERVAL_MS = 1_000
export const MAX_SENDS_PER_MINUTE = 18
/** Telegram's limit is 4096 chars of text; keep headroom for the "dropped" notice */
export const MAX_TELEGRAM_CHARS = 4_000
export const DIGEST_MAX_LINES = 10
const ITEM_BUDGET_CHARS = 3_800
const MAX_QUEUE_ITEMS = 500
const MAX_DIGEST_KINDS = 15
const SEPARATOR = '\n\n'
const DEFAULT_TOKEN_DECIMALS = 6

export interface TelegramAlerterOptions {
  /** TELEGRAM_BOT_TOKEN — omitted (or chatId omitted) → log + sink only */
  botToken?: string
  /** TELEGRAM_CHAT_ID */
  chatId?: string
  /** TELEGRAM_DIGEST_SECONDS */
  digestSeconds: number
  sink: EventsSink
  fetchImpl?: typeof fetch
  now?: () => Date
  logger?: AlertLogger
  /** prefixed to every Telegram message, e.g. "devnet·local" (so rehearsal and mainnet chats never mix) */
  label?: string
  apiBase?: string
  dedupeWindowMs?: number
  minSendIntervalMs?: number
  maxSendsPerMinute?: number
  requestTimeoutMs?: number
}

interface QueueItem {
  text: string
  /** failed sends so far (a second failure drops it) */
  attempts: number
  /** send without parse_mode (after Telegram rejected the HTML) */
  plain: boolean
}

interface DedupeEntry {
  at: number
  kind: string
  severity: Severity
  suppressed: number
}

interface DigestKind {
  count: number
  sumRaw: bigint
  hasSum: boolean
  decimals: number
  severity: Severity
}

interface DigestLine {
  severity: Severity
  text: string
}

interface SendResult {
  ok: boolean
  status: number
  retryAfterMs?: number
  error?: string
}

interface TelegramResponse {
  ok?: boolean
  description?: string
  parameters?: { retry_after?: number }
}

type Timer = ReturnType<typeof setTimeout>

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 }

export class TelegramAlerter implements Alerter {
  /** true when Telegram delivery is configured (otherwise log + sink only) */
  readonly enabled: boolean

  private readonly botToken: string
  private readonly chatId: string
  private readonly digestMs: number
  private readonly sink: EventsSink
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  private readonly logger: AlertLogger
  private readonly label: string
  private readonly apiBase: string
  private readonly dedupeWindowMs: number
  private readonly minIntervalMs: number
  private readonly maxPerMinute: number
  private readonly requestTimeoutMs: number
  private readonly secrets: string[]

  private queue: QueueItem[] = []
  private droppedFromQueue = 0
  private inFlight: Promise<void> | null = null
  private pumpQueued = false
  private pumpTimer: Timer | null = null
  private flushing = false
  private closed = false
  private sendTimes: number[] = []
  private lastSendAt = Number.NEGATIVE_INFINITY
  private notBefore = 0

  private readonly dedupe = new Map<string, DedupeEntry>()
  private readonly pendingWrites = new Set<Promise<void>>()

  private digestKinds = new Map<string, DigestKind>()
  private digestLines: DigestLine[] = []
  private digestTotal = 0
  private digestStartedAt = 0
  private digestTimer: Timer | null = null

  constructor(opts: TelegramAlerterOptions) {
    this.botToken = opts.botToken?.trim() ?? ''
    this.chatId = opts.chatId?.trim() ?? ''
    this.enabled = this.botToken !== '' && this.chatId !== ''
    this.digestMs = Math.max(1, opts.digestSeconds) * 1_000
    this.sink = opts.sink
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.now = opts.now ?? (() => new Date())
    this.logger = opts.logger ?? jsonLineLogger
    this.label = opts.label?.trim() ?? ''
    this.apiBase = (opts.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '')
    this.dedupeWindowMs = opts.dedupeWindowMs ?? DEDUPE_WINDOW_MS
    this.minIntervalMs = opts.minSendIntervalMs ?? MIN_SEND_INTERVAL_MS
    this.maxPerMinute = Math.max(1, opts.maxSendsPerMinute ?? MAX_SENDS_PER_MINUTE)
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000
    this.secrets = this.botToken ? [this.botToken] : []
  }

  // ── Alerter ────────────────────────────────────────────────────────────────
  notify(event: AlertEvent): void {
    let e: AlertEvent
    try {
      e = sanitizeEvent(event, this.secrets)
    } catch {
      e = {
        kind: 'alerts.unserializable',
        severity: 'warn',
        message: 'an alert event could not be sanitized',
      }
    }
    this.logEvent(e)
    this.persist(e)
    if (!this.enabled || this.closed) return
    try {
      const d = this.checkDedupe(e)
      if (d.suppress) return
      if (e.immediate) this.enqueue(this.formatImmediate(e, d.repeats))
      else this.addToDigest(e, d.repeats)
    } catch (err) {
      this.safeLog(
        'error',
        { alert: 'alerts.internal_error', error: this.errText(err) },
        'alert delivery failed',
      )
    }
  }

  /** Send the pending digest and everything queued now (bypassing pacing), and wait for sink writes. */
  async flush(): Promise<void> {
    try {
      await this.settleWrites()
      if (!this.enabled) return
      this.flushing = true
      this.clearTimer('digestTimer')
      this.clearTimer('pumpTimer')
      this.closeDigest()
      // every item is sent at most twice (one retry), so this terminates
      for (let guard = 0; guard < 10_000; guard++) {
        if (this.inFlight) {
          await this.inFlight
          continue
        }
        if (this.queue.length === 0) break
        this.startSend()
        await this.inFlight
      }
      await this.settleWrites()
    } catch (err) {
      this.safeLog('error', { alert: 'alerts.flush_error', error: this.errText(err) }, 'alert flush failed')
    } finally {
      this.flushing = false
      if (this.queue.length > 0) this.schedulePump()
    }
  }

  /** flush, then stop all timers; later notify() calls only reach the sink + log */
  async close(): Promise<void> {
    await this.flush()
    this.closed = true
    this.clearTimer('digestTimer')
    this.clearTimer('pumpTimer')
  }

  // ── sink + log ─────────────────────────────────────────────────────────────
  private logEvent(e: AlertEvent): void {
    const level: LogLevel = e.severity === 'critical' ? 'error' : e.severity === 'warn' ? 'warn' : 'info'
    const obj: Record<string, unknown> = { alert: e.kind, severity: e.severity }
    if (e.immediate) obj.immediate = true
    if (e.dedupeKey) obj.dedupeKey = e.dedupeKey
    if (e.data) obj.data = e.data
    this.safeLog(level, obj, e.message)
  }

  private persist(e: AlertEvent): void {
    let write: Promise<void>
    try {
      write = Promise.resolve(this.sink.write(e))
    } catch (err) {
      write = Promise.reject(err)
    }
    const tracked: Promise<void> = write
      .catch((err: unknown) => {
        this.safeLog(
          'error',
          { alert: 'alerts.sink_error', kind: e.kind, error: this.errText(err) },
          'failed to persist alert event',
        )
      })
      .finally(() => {
        this.pendingWrites.delete(tracked)
      })
    this.pendingWrites.add(tracked)
  }

  private async settleWrites(): Promise<void> {
    while (this.pendingWrites.size > 0) await Promise.allSettled([...this.pendingWrites])
  }

  private safeLog(level: LogLevel, obj: Record<string, unknown>, msg: string): void {
    try {
      this.logger[level](obj, msg)
    } catch {
      /* logging must never break alerting */
    }
  }

  private errText(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err)
    return redactText(msg, this.secrets).slice(0, 500)
  }

  // ── dedupe ─────────────────────────────────────────────────────────────────
  private checkDedupe(e: AlertEvent): { suppress: boolean; repeats: number } {
    if (!e.dedupeKey) return { suppress: false, repeats: 0 }
    const now = this.nowMs()
    const prev = this.dedupe.get(e.dedupeKey)
    if (prev && prev.kind === e.kind && prev.severity === e.severity && now - prev.at < this.dedupeWindowMs) {
      prev.suppressed++
      return { suppress: true, repeats: 0 }
    }
    const repeats = prev && prev.kind === e.kind ? prev.suppressed : 0
    this.dedupe.set(e.dedupeKey, { at: now, kind: e.kind, severity: e.severity, suppressed: 0 })
    if (this.dedupe.size > 1_000) {
      for (const [k, v] of this.dedupe) if (now - v.at >= this.dedupeWindowMs) this.dedupe.delete(k)
    }
    return { suppress: false, repeats }
  }

  // ── digest ─────────────────────────────────────────────────────────────────
  private addToDigest(e: AlertEvent, repeats: number): void {
    if (this.digestTotal === 0) this.digestStartedAt = this.nowMs()
    this.digestTotal++
    const k = this.digestKinds.get(e.kind) ?? {
      count: 0,
      sumRaw: 0n,
      hasSum: false,
      decimals: DEFAULT_TOKEN_DECIMALS,
      severity: 'info' as Severity,
    }
    k.count++
    const amount = parseRaw(e.data?.amountRaw)
    if (amount !== null) {
      k.sumRaw += amount
      k.hasSum = true
      const dec = e.data?.decimals
      if (typeof dec === 'number' && Number.isInteger(dec) && dec >= 0 && dec <= 18) k.decimals = dec
    }
    if (SEVERITY_RANK[e.severity] > SEVERITY_RANK[k.severity]) k.severity = e.severity
    this.digestKinds.set(e.kind, k)

    const line: DigestLine = {
      severity: e.severity,
      text: clip(e.message, 200) + (repeats > 0 ? ` (+${repeats} repeats)` : ''),
    }
    if (this.digestLines.length < DIGEST_MAX_LINES) {
      this.digestLines.push(line)
    } else if (e.severity !== 'info') {
      // keep warnings visible: evict the oldest info line
      const i = this.digestLines.findIndex((l) => l.severity === 'info')
      if (i >= 0) {
        this.digestLines.splice(i, 1)
        this.digestLines.push(line)
      }
    }
    if (!this.digestTimer) {
      this.digestTimer = this.timer(() => {
        this.digestTimer = null
        this.closeDigest()
      }, this.digestMs)
    }
  }

  private closeDigest(): void {
    if (this.digestTotal === 0) return
    const text = this.formatDigest()
    this.digestKinds = new Map()
    this.digestLines = []
    this.digestTotal = 0
    this.enqueue(text)
  }

  private formatDigest(): string {
    const secs = Math.max(1, Math.round((this.nowMs() - this.digestStartedAt) / 1_000))
    const parts: string[] = [
      `${this.labelHtml()}<b>Digest</b> · ${this.digestTotal} event${this.digestTotal === 1 ? '' : 's'} · last ${secs}s`,
    ]
    const kinds = [...this.digestKinds.entries()].sort((a, b) => b[1].count - a[1].count)
    for (const [kind, k] of kinds.slice(0, MAX_DIGEST_KINDS)) {
      const total = k.hasSum ? `: ${formatPumpCompact(k.sumRaw, k.decimals)} PUMP total` : ''
      parts.push(escapeHtml(`${kindEmoji(kind, k.severity)} ${describeKind(kind, k.count)}${total}`))
    }
    if (kinds.length > MAX_DIGEST_KINDS)
      parts.push(escapeHtml(`…and ${kinds.length - MAX_DIGEST_KINDS} more kinds`))
    let used = parts.join('\n').length
    let listed = 0
    for (const l of this.digestLines) {
      const row = `${l.severity === 'info' ? '–' : severityEmoji(l.severity)} ${escapeHtml(l.text)}`
      if (used + row.length + 1 > ITEM_BUDGET_CHARS) break
      parts.push(row)
      used += row.length + 1
      listed++
    }
    if (this.digestTotal > listed) parts.push(`<i>…and ${this.digestTotal - listed} more</i>`)
    return parts.join('\n')
  }

  // ── immediate ──────────────────────────────────────────────────────────────
  private formatImmediate(e: AlertEvent, repeats: number): string {
    const emoji = e.severity === 'info' ? kindEmoji(e.kind, e.severity) : severityEmoji(e.severity)
    const head = `${this.labelHtml()}${emoji} <b>${e.severity.toUpperCase()}</b> · ${escapeHtml(clip(e.kind, 80))}`
    const lines = [head, escapeHtml(clip(e.message, 2_800))]
    const data = describeData(e.data)
    if (data) lines.push(`<i>${escapeHtml(data)}</i>`)
    if (repeats > 0) lines.push(`<i>(+${repeats} similar suppressed in the last ${this.windowText()})</i>`)
    return lines.join('\n')
  }

  private labelHtml(): string {
    return this.label ? `[${escapeHtml(clip(this.label, 40))}] ` : ''
  }

  private windowText(): string {
    const mins = Math.round(this.dedupeWindowMs / 60_000)
    return mins >= 1 ? `${mins} min` : `${Math.round(this.dedupeWindowMs / 1_000)}s`
  }

  // ── queue + pacing ─────────────────────────────────────────────────────────
  private enqueue(text: string): void {
    this.queue.push({ text, attempts: 0, plain: false })
    if (this.queue.length > MAX_QUEUE_ITEMS) {
      const drop = this.queue.length - MAX_QUEUE_ITEMS
      this.queue.splice(0, drop) // newest state matters most; every event is in Postgres anyway
      this.droppedFromQueue += drop
    }
    this.schedulePump()
  }

  /** pump on the next microtask so a synchronous burst of notify() calls merges into one message */
  private schedulePump(): void {
    if (this.pumpQueued || this.closed) return
    this.pumpQueued = true
    queueMicrotask(() => {
      this.pumpQueued = false
      this.pump()
    })
  }

  private pump(): void {
    if (this.closed || this.flushing || this.inFlight || this.queue.length === 0) return
    const wait = this.nextSendAt() - this.nowMs()
    if (wait > 0) {
      if (!this.pumpTimer) {
        this.pumpTimer = this.timer(() => {
          this.pumpTimer = null
          this.pump()
        }, wait)
      }
      return
    }
    this.startSend()
  }

  private nextSendAt(): number {
    const now = this.nowMs()
    this.sendTimes = this.sendTimes.filter((t) => now - t < 60_000)
    let at = Math.max(this.lastSendAt + this.minIntervalMs, this.notBefore)
    if (this.sendTimes.length >= this.maxPerMinute) {
      at = Math.max(at, this.sendTimes[this.sendTimes.length - this.maxPerMinute]! + 60_000)
    }
    return at
  }

  private startSend(): void {
    const batch = this.takeBatch()
    if (batch.length === 0) return
    this.inFlight = this.sendBatch(batch)
      .catch((err: unknown) => {
        this.safeLog(
          'error',
          { alert: 'alerts.telegram_error', error: this.errText(err) },
          'telegram send crashed',
        )
      })
      .finally(() => {
        this.inFlight = null
        this.pump()
      })
  }

  /** merge queued items (same parse mode) into one message up to Telegram's size limit */
  private takeBatch(): QueueItem[] {
    const first = this.queue.shift()
    if (!first) return []
    const batch = [first]
    let len = first.text.length
    while (this.queue.length > 0) {
      const next = this.queue[0]!
      if (next.plain !== first.plain || len + SEPARATOR.length + next.text.length > MAX_TELEGRAM_CHARS) break
      batch.push(this.queue.shift()!)
      len += SEPARATOR.length + next.text.length
    }
    return batch
  }

  private async sendBatch(batch: QueueItem[]): Promise<void> {
    const plain = batch[0]!.plain
    const droppedNow = this.droppedFromQueue
    let text = batch.map((i) => i.text).join(SEPARATOR)
    let noticed = false
    if (droppedNow > 0) {
      const notice = `⚠️ <i>${droppedNow} alert message(s) dropped from the Telegram queue — see the events table</i>`
      if (text.length + SEPARATOR.length + notice.length <= 4_096) {
        text = `${notice}${SEPARATOR}${text}`
        noticed = true
      }
    }
    const at = this.nowMs()
    this.lastSendAt = at
    this.sendTimes.push(at)
    const res = await this.post(plain ? htmlToPlain(text) : text, plain)
    if (res.ok) {
      if (noticed) this.droppedFromQueue -= droppedNow
      return
    }
    this.notBefore = this.nowMs() + Math.max(res.retryAfterMs ?? 0, this.minIntervalMs)
    const retry: QueueItem[] = []
    let dropped = 0
    for (const item of batch) {
      item.attempts++
      if (item.attempts >= 2) dropped++
      else retry.push({ ...item, plain: item.plain || res.status === 400 })
    }
    this.queue.unshift(...retry)
    if (dropped > 0) {
      this.safeLog(
        'error',
        { alert: 'alerts.telegram_failed', status: res.status, error: res.error, dropped },
        'telegram send failed twice; message dropped (events are in Postgres)',
      )
    } else {
      this.safeLog(
        'warn',
        {
          alert: 'alerts.telegram_retry',
          status: res.status,
          error: res.error,
          retryInMs: this.notBefore - this.nowMs(),
        },
        'telegram send failed; retrying once',
      )
    }
  }

  private async post(text: string, plain: boolean): Promise<SendResult> {
    try {
      const body: Record<string, unknown> = { chat_id: this.chatId, text, disable_web_page_preview: true }
      if (!plain) body.parse_mode = 'HTML'
      const res = await this.fetchImpl(`${this.apiBase}/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
      let payload: TelegramResponse | null = null
      try {
        payload = (await res.json()) as TelegramResponse
      } catch {
        payload = null
      }
      if (res.ok && payload?.ok !== false) return { ok: true, status: res.status }
      const retryAfter = payload?.parameters?.retry_after
      const out: SendResult = {
        ok: false,
        status: res.status,
        error: redactText(String(payload?.description ?? `HTTP ${res.status}`), this.secrets).slice(0, 300),
      }
      if (typeof retryAfter === 'number' && retryAfter > 0)
        out.retryAfterMs = Math.min(retryAfter, 300) * 1_000
      return out
    } catch (err) {
      return { ok: false, status: 0, error: this.errText(err) }
    }
  }

  // ── timers ─────────────────────────────────────────────────────────────────
  private nowMs(): number {
    return this.now().getTime()
  }

  private timer(fn: () => void, ms: number): Timer {
    const t = setTimeout(
      () => {
        try {
          fn()
        } catch (err) {
          this.safeLog(
            'error',
            { alert: 'alerts.timer_error', error: this.errText(err) },
            'alert timer failed',
          )
        }
      },
      Math.max(0, ms),
    )
    t.unref?.()
    return t
  }

  private clearTimer(which: 'digestTimer' | 'pumpTimer'): void {
    const t = this[which]
    if (t) clearTimeout(t)
    this[which] = null
  }
}

// ── formatting helpers ───────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function htmlToPlain(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function parseRaw(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v
  if (typeof v === 'string' && /^-?\d{1,40}$/.test(v)) return BigInt(v)
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v)
  return null
}

function severityEmoji(s: Severity): string {
  return s === 'critical' ? '🚨' : s === 'warn' ? '⚠️' : 'ℹ️'
}

function kindEmoji(kind: string, severity: Severity): string {
  if (severity !== 'info') return severityEmoji(severity)
  const noun = kind.split('.')[0] ?? ''
  if (/^(payout|payouts|win|ticket|tickets)$/.test(noun)) return '🎫'
  if (/^jackpot$/.test(noun)) return '💰'
  if (/^(sweep|sweeper|claim|swap|fees?)$/.test(noun)) return '🧹'
  return severityEmoji(severity)
}

const STATE_WORDS = new Set(['done', 'sent', 'paid', 'ok', 'won', 'hit', 'split', 'claimed', 'swapped'])

/** "payout.confirmed" ×12 → "12 payouts confirmed"; anything else → "3× monitor.check_failed" */
function describeKind(kind: string, count: number): string {
  const [noun, verb, ...rest] = kind.split('.')
  if (rest.length === 0 && noun && verb && /^[a-z]+$/.test(noun) && /^[a-z_]+$/.test(verb)) {
    if (verb.endsWith('ed') || STATE_WORDS.has(verb)) {
      const n = count === 1 ? noun : noun.endsWith('s') ? noun : `${noun}s`
      return `${count} ${n} ${verb.replace(/_/g, ' ')}`
    }
  }
  return `${count}× ${kind}`
}

/** compact "k: v · k: v" rendering of an event's top-level scalar data */
function describeData(data: Record<string, unknown> | undefined): string {
  if (!data) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(data)) {
    if (v === null || typeof v === 'object') continue
    parts.push(`${k}: ${clip(String(v), 64)}`)
    if (parts.length >= 8) break
  }
  return clip(parts.join(' · '), 500)
}

/**
 * Ops alerts (PLAN §5): every payout, sweep and breaker event goes to Postgres AND Telegram.
 * Routine payouts are batched into digests (TELEGRAM_DIGEST_SECONDS); anything `immediate` posts at once.
 */
export type Severity = 'info' | 'warn' | 'critical'

export interface AlertEvent {
  kind: string
  severity: Severity
  message: string
  data?: Record<string, unknown>
  /** bypass the digest (big wins, jackpots, failures, breaker, pauses) */
  immediate?: boolean
  /** suppress repeats of the same key within the dedupe window (e.g. "low_gas") */
  dedupeKey?: string
}

export interface Alerter {
  notify(event: AlertEvent): void
  /** flush pending digests (shutdown / tests) */
  flush(): Promise<void>
}

import { eq, like } from 'drizzle-orm'
import type { Alerter } from '../alerts/types'
import type { Db } from '../db/client'
import { config } from '../db/schema'

/**
 * Pauses that do NOT clear themselves (docs/ECONOMY.md "Pauses and how they resume"):
 *   manual            — admin
 *   breaker_mismatch  — a revealed prize failed seed recomputation (Decision E hard stop)
 *   invariant         — an unexplained outflow from the PRIZE wallet, or a detected double payment
 *   mint_changed      — the payout mint's Token-2022 extensions / transfer hook changed (review before paying)
 *   payouts_stuck     — a PRIZE payout keeps failing to simulate (never retry silently forever)
 * Persisted in the §3.1 `config` table as `pause.<reason>`; every process re-reads them every SYNC_MS, so a
 * pause set anywhere (admin, engine leader, another replica) stops every worker within seconds, and a restart
 * never silently resumes payouts. Self-clearing pauses (low_gas / low_pool) live in the WalletMonitor; per-round
 * breaker holds live on the payout rows.
 */
export type HardPauseReason = 'manual' | 'breaker_mismatch' | 'invariant' | 'mint_changed' | 'payouts_stuck'
export const HARD_PAUSE_REASONS: readonly HardPauseReason[] = [
  'manual',
  'breaker_mismatch',
  'invariant',
  'mint_changed',
  'payouts_stuck',
]
export const PAUSE_SYNC_MS = 2_000

export interface PauseInfo {
  reason: HardPauseReason
  note: string
  at: string
}

export class PauseRegistry {
  private active = new Map<HardPauseReason, PauseInfo>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly db: Db,
    private readonly alerter: Alerter,
  ) {}

  async load(): Promise<void> {
    const rows = await this.db.select().from(config).where(like(config.key, 'pause.%'))
    this.active.clear()
    for (const r of rows) {
      const reason = r.key.slice('pause.'.length) as HardPauseReason
      if (!HARD_PAUSE_REASONS.includes(reason)) continue
      try {
        this.active.set(reason, JSON.parse(r.value) as PauseInfo)
      } catch {
        this.active.set(reason, { reason, note: r.value, at: r.updatedAt.toISOString() })
      }
    }
  }

  /** keep this process in sync with pauses set by any other process */
  startSync(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.load().catch(() => {}), PAUSE_SYNC_MS)
    this.timer.unref()
  }

  stopSync(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  list(): PauseInfo[] {
    return [...this.active.values()]
  }

  first(): HardPauseReason | null {
    for (const r of HARD_PAUSE_REASONS) if (this.active.has(r)) return r
    return null
  }

  async set(reason: HardPauseReason, note: string): Promise<void> {
    const info: PauseInfo = { reason, note, at: new Date().toISOString() }
    await this.db
      .insert(config)
      .values({ key: `pause.${reason}`, value: JSON.stringify(info) })
      .onConflictDoUpdate({ target: config.key, set: { value: JSON.stringify(info), updatedAt: new Date() } })
    const was = this.active.has(reason)
    this.active.set(reason, info)
    if (!was) {
      this.alerter.notify({
        kind: `pause.${reason}`,
        severity: 'critical',
        message: `payouts PAUSED (${reason}): ${note}`,
        immediate: true,
      })
    }
  }

  async clear(reason: HardPauseReason, note: string): Promise<void> {
    await this.db.delete(config).where(eq(config.key, `pause.${reason}`))
    if (this.active.delete(reason)) {
      this.alerter.notify({
        kind: `resume.${reason}`,
        severity: 'warn',
        message: `payouts RESUMED (${reason} cleared): ${note}`,
        immediate: true,
      })
    }
  }
}

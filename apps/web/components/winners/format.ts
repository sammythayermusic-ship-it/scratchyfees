import { scaledToDecimal } from '@scratchy/core'
import type { api } from '@/lib/api'
import { PUMP_DECIMALS } from '@/lib/config'
import type { WinnerRow } from '@/lib/types'

/** Winners-page display helpers. PUMP amounts are shown exactly; "~$" is always an estimate. */

export type WinnersPage = Awaited<ReturnType<typeof api.winners>>
export type WinnersStats = Awaited<ReturnType<typeof api.stats>>

export const winTotalRaw = (r: WinnerRow): bigint => BigInt(r.prizeRaw) + BigInt(r.jackpotPrizeRaw)
export const isJackpotWin = (r: WinnerRow): boolean => BigInt(r.jackpotPrizeRaw) > 0n

/** Exact PUMP amount split for display: grouped whole part + every fractional digit (nothing rounded). */
export function exactPumpParts(raw: bigint): { whole: string; frac: string } {
  const [whole = '0', frac = ''] = scaledToDecimal(raw, PUMP_DECIMALS).split('.')
  return { whole: BigInt(whole).toLocaleString('en-US'), frac }
}

export function timeAgo(iso: string, now: number): string {
  const s = Math.floor((now - Date.parse(iso)) / 1000)
  if (!Number.isFinite(s) || s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export type PayoutTone = 'paid' | 'pending' | 'hold' | 'bad'

/** Payout lifecycle (apps/api payouts.status) → a short human label. `null` = not known yet (live row). */
export function payoutMeta(status: string | null): { label: string; tone: PayoutTone } {
  switch (status) {
    case 'confirmed':
      return { label: 'paid', tone: 'paid' }
    case 'sending':
      return { label: 'confirming…', tone: 'pending' }
    case 'queued':
      return { label: 'queued', tone: 'pending' }
    case 'failed':
      return { label: 'retrying', tone: 'pending' }
    case 'held':
      return { label: 'safety check', tone: 'hold' }
    case 'failed_permanent':
      return { label: 'undeliverable', tone: 'bad' }
    case null:
      return { label: 'sending…', tone: 'pending' }
    default:
      return { label: status, tone: 'pending' }
  }
}

/** Statuses that will not change any more (no need to keep polling for them). */
export const FINAL_PAYOUT_STATUSES: ReadonlySet<string> = new Set(['confirmed', 'failed_permanent'])

/** Badge colours per tier, matching the ticket rarity frames in globals.css. */
export const TIER_BADGE: Record<number, string> = {
  0: 'bg-stage-3/70 text-muted ring-muted/30',
  1: 'bg-pink/15 text-[#ff9fe6] ring-pink/45',
  2: 'bg-violet/20 text-[#e7a5ff] ring-violet/55',
  3: 'bg-gold/15 text-gold ring-gold/50',
  4: 'bg-gradient-to-r from-pink/35 to-gold/30 text-gold-hi ring-gold/60',
  5: 'bg-gradient-to-r from-magenta/45 via-gold/35 to-violet/45 text-ink ring-gold-hi/70',
}

/** Animated rainbow-foil frame for jackpot hits (reuses the `frame-flow` keyframes from globals.css). */
export const JACKPOT_FRAME =
  'bg-[linear-gradient(90deg,#ff5ebc,#fdf771,#5ae3ff,#a802ee,#fdf771,#ff5ebc)] bg-[length:400%_100%] animate-[frame-flow_2.4s_linear_infinite] shadow-[0_0_34px_-6px_rgba(251,213,63,0.9)]'

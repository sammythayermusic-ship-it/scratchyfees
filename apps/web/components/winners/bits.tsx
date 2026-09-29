import {
  fmtUsd,
  multLabel,
  shortWallet,
  solscanAccount,
  solscanTx,
  TIER_MULTIPLE,
  TIER_NAMES,
} from '@/lib/money'
import type { WinnerRow } from '@/lib/types'
import { exactPumpParts, isJackpotWin, payoutMeta, TIER_BADGE, winTotalRaw } from './format'

/** Exact PUMP amount: big whole part, every fractional digit kept (smaller), then the unit. */
export function PumpAmount({
  raw,
  className = '',
  unitClassName = 'text-gold',
}: {
  raw: bigint
  className?: string
  unitClassName?: string
}) {
  const { whole, frac } = exactPumpParts(raw)
  return (
    <span className={`tabular-nums ${className}`}>
      {whole}
      {frac && <span className="text-[0.62em] opacity-80">.{frac}</span>}{' '}
      <span className={`text-[0.7em] ${unitClassName}`}>PUMP</span>
    </span>
  )
}

/** "~$42" at the PUMP price known when the ticket was revealed (estimate only). */
export function UsdAtReveal({ row, className = '' }: { row: WinnerRow; className?: string }) {
  const usd = fmtUsd(winTotalRaw(row), row.pumpUsdE18)
  return (
    <span
      className={`text-xs text-muted ${className}`}
      title="Estimate at the PUMP price when this ticket was revealed. The PUMP amount is what was paid."
    >
      {usd || 'no $ estimate'}
    </span>
  )
}

/** Wallet (links to Solscan) + the optional X handle, clearly marked as self-reported. */
export function Who({ row }: { row: WinnerRow }) {
  const wallet = (
    <a
      href={solscanAccount(row.wallet)}
      target="_blank"
      rel="noreferrer noopener"
      title={row.wallet}
      className={
        row.xHandle
          ? 'shrink-0 font-mono text-xs text-muted hover:text-ink'
          : 'truncate font-mono text-sm font-semibold text-ink hover:text-gold'
      }
    >
      {shortWallet(row.wallet)}
    </a>
  )
  if (!row.xHandle) return <span className="flex min-w-0 items-center">{wallet}</span>
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="truncate text-sm font-semibold text-ink">@{row.xHandle}</span>
      <span
        className="rounded bg-stage-3/80 px-1 py-px text-[10px] font-semibold uppercase tracking-wider text-muted"
        title="X handles are typed in by players and are not verified. The wallet is what gets paid."
      >
        unverified
      </span>
      {wallet}
    </span>
  )
}

/** Tier name + multiple of e, a JACKPOT badge when the ticket also hit the pot, and the whale boost if any. */
export function TierBadges({ row }: { row: WinnerRow }) {
  const jackpot = isJackpotWin(row)
  const mult = row.multMicro ? BigInt(row.multMicro) : null
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {jackpot && (
        <span className="rounded-full bg-gradient-to-r from-pink via-gold to-violet px-2 py-0.5 font-display text-xs tracking-wide text-stage shadow-[0_0_14px_rgba(251,213,63,0.7)]">
          🚨 JACKPOT
        </span>
      )}
      {(!jackpot || row.tier > 0) && (
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-bold ring-1 ${TIER_BADGE[row.tier] ?? TIER_BADGE[0]}`}
        >
          {TIER_NAMES[row.tier]} · {TIER_MULTIPLE[row.tier]}×
        </span>
      )}
      {mult !== null && mult > 1_000_000n && (
        <span
          className="rounded-full bg-stage/70 px-2 py-0.5 text-xs text-magenta ring-1 ring-magenta/35"
          title="Whale multiplier on this wallet's prizes"
        >
          {multLabel(mult)} whale
        </span>
      )}
    </span>
  )
}

const TONE: Record<string, string> = {
  paid: 'bg-emerald-400',
  pending: 'bg-gold animate-pulse',
  hold: 'bg-gold-deep',
  bad: 'bg-pink',
}

/** Payout status chip; links the transaction on Solscan (cluster from lib/config) once there is one. */
export function PayoutStatus({ row }: { row: WinnerRow }) {
  const meta = payoutMeta(row.payoutStatus)
  return (
    <span className="flex items-center gap-2 text-xs">
      <span
        className="inline-flex items-center gap-1.5 text-muted"
        title={
          meta.tone === 'hold'
            ? 'Held for the round safety check — released automatically when the round ends.'
            : meta.tone === 'bad'
              ? 'This transfer could not be delivered; the PUMP stayed in the prize pool.'
              : undefined
        }
      >
        <span className={`h-2 w-2 rounded-full ${TONE[meta.tone]}`} aria-hidden />
        {meta.label}
      </span>
      {row.txSig && (
        <a
          href={solscanTx(row.txSig)}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="View the payout transaction on Solscan"
          className="rounded-full bg-stage/70 px-2 py-0.5 font-semibold text-gold ring-1 ring-gold/30 hover:bg-gold/15"
        >
          tx ↗
        </a>
      )}
    </span>
  )
}

'use client'

import { useLive, useServerNow } from '@/lib/live'
import { fmtUsd } from '@/lib/money'
import { formatPump } from '@scratchy/core'
import { Odometer } from './Odometer'

const MILESTONES = [
  10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000, 25_000_000,
  50_000_000, 100_000_000,
]

export function countdownText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Live pool counter (PUMP + ~$), climbing jackpot meter, and the countdown to the next drop. */
export function StatsBand() {
  const { snapshot } = useLive()
  const now = useServerNow(250)
  const poolRaw = snapshot?.pool.raw ?? '0'
  const jackpotRaw = snapshot?.pool.jackpotRaw ?? '0'
  const price = snapshot?.prices.pumpUsdE18 ?? null
  const endsAt =
    snapshot?.round?.status === 'live'
      ? Date.parse(snapshot.round.endsAt)
      : snapshot?.nextRound
        ? Date.parse(snapshot.nextRound.startsAt)
        : null
  const left = endsAt ? endsAt - now : null
  const jackpotWhole = Number(BigInt(jackpotRaw) / 1_000_000n)
  const milestone = MILESTONES.find((m) => m > jackpotWhole) ?? jackpotWhole * 2 + 1
  const fill = Math.min(100, (jackpotWhole / milestone) * 100)

  return (
    <section className="grid gap-3 sm:grid-cols-3" aria-label="Live pool, jackpot and next drop">
      <div className="panel px-5 py-4 text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-muted">Prize pool</p>
        <p className="font-display mt-1 text-3xl text-ink sm:text-4xl">
          <Odometer value={formatPump(BigInt(poolRaw), 6)} />
          <span className="ml-2 text-lg text-gold">PUMP</span>
        </p>
        <p className="text-sm text-muted">{fmtUsd(poolRaw, price) || '—'}</p>
      </div>
      <div className="panel relative overflow-hidden px-5 py-4 text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-gold">Progressive jackpot</p>
        <p className="font-display mt-1 text-3xl sm:text-4xl">
          <Odometer value={formatPump(BigInt(jackpotRaw), 6)} glyphClassName="foil-text" />
          <span className="foil-text ml-2 text-lg">PUMP</span>
        </p>
        <div className="mx-auto mt-2 h-2.5 w-full overflow-hidden rounded-full bg-stage/70" aria-hidden>
          <div
            className="h-full rounded-full bg-gradient-to-r from-pink via-gold to-gold-hi shadow-[0_0_14px_rgba(251,213,63,0.9)] transition-[width] duration-1000 animate-pulse-glow"
            style={{ width: `${fill}%` }}
          />
        </div>
        <p className="mt-1 text-xs text-muted">
          {fmtUsd(jackpotRaw, price)} · 1-in-50,000 per ticket · same for everyone
        </p>
      </div>
      <div className="panel px-5 py-4 text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-muted">Next drop in</p>
        <p className="font-display mt-1 text-4xl tabular-nums text-ink glow-pink sm:text-5xl">
          {left === null ? '–:––' : countdownText(left)}
        </p>
        <p className="text-xs text-muted">
          {snapshot?.paused
            ? `payouts paused (${snapshot.paused.replace('_', ' ')})`
            : snapshot?.prices.state === 'frozen'
              ? 'prices stale — eligibility frozen, payouts unaffected'
              : `new tickets every ${roundEvery(snapshot?.roundSeconds ?? 600)}`}
        </p>
      </div>
    </section>
  )
}

/** "10 minutes" / "minute" / "90 seconds" for the round length the server runs */
export function roundEvery(seconds: number): string {
  if (seconds % 60 !== 0) return `${seconds} seconds`
  const m = seconds / 60
  return m === 1 ? 'minute' : `${m} minutes`
}

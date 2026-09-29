import { useServerNow } from '@/lib/live'
import { countdownText } from '@/components/home/StatsBand'
import { CopyButton } from './CopyButton'
import type { FairRoundData } from './verify'

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** The seed is still secret: show the commitment and when it will be revealed. */
export function Unrevealed({ round, onCheckAgain }: { round: FairRoundData; onCheckAgain: () => void }) {
  const now = useServerNow(1000)
  const endsAt = Date.parse(round.endsAt)
  const startsAt = Date.parse(round.startsAt)
  const left = endsAt - now
  // from the clock, not the fetched status — a pending round goes live while you watch
  const pending = startsAt > now
  return (
    <section className="panel p-4 sm:p-6" aria-labelledby="unrevealed-heading">
      <p className="text-xs uppercase tracking-[0.2em] text-gold">
        {pending ? 'Not started yet' : 'Live right now'}
      </p>
      <h3 id="unrevealed-heading" className="font-display text-2xl">
        <span aria-hidden>🔒 </span>Round #{round.id}&apos;s seed is still secret
      </h3>
      <p className="mt-1 text-sm text-muted">
        {pending ? `It starts at ${clock(round.startsAt)} (in ${countdownText(startsAt - now)}). ` : ''}
        The seed is revealed when the round ends
        {left > 0 ? (
          <>
            {' '}
            at <span className="text-ink">{clock(round.endsAt)}</span> — in{' '}
            <span className="font-display text-lg tabular-nums text-ink glow-pink">
              {countdownText(left)}
            </span>
            .
          </>
        ) : (
          ' — any moment now.'
        )}{' '}
        Its hash was published before the round started, so the outcome of every ticket is already locked in.
      </p>
      <div className="mt-4 rounded-xl border border-magenta/20 bg-stage/70 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs uppercase tracking-[0.2em] text-muted">Committed seed hash · sha256</p>
          <CopyButton value={round.seedHash} label="Copy committed seed hash" />
        </div>
        <p className="mt-1 break-all font-mono text-sm text-ink">{round.seedHash}</p>
      </div>
      <p className="mt-3 text-xs text-muted">
        Save this hash now. After the reveal, sha256(seed) must equal it — this page checks that
        automatically.
      </p>
      {left <= 0 && (
        <button type="button" className="btn-pink mt-3" onClick={onCheckAgain}>
          Check again
        </button>
      )}
    </section>
  )
}

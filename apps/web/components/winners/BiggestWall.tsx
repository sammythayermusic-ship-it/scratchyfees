import type { WinnerRow } from '@/lib/types'
import { PayoutStatus, PumpAmount, TierBadges, UsdAtReveal, Who } from './bits'
import { isJackpotWin, JACKPOT_FRAME, timeAgo, winTotalRaw } from './format'

const PODIUM_FRAME = 'bg-[linear-gradient(135deg,#fdf771,#df8d21_30%,#fbd53f_55%,#b86a14_80%,#fdf771)]'

/** All-time biggest wins: a swipeable strip on phones, a ranked column on desktop. */
export function BiggestWall({
  rows,
  state,
  now,
}: {
  rows: WinnerRow[]
  state: 'loading' | 'ready' | 'error'
  now: number
}) {
  return (
    <section aria-labelledby="biggest-heading" className="min-w-0">
      <div className="mb-3 flex items-end justify-between gap-2">
        <h2 id="biggest-heading" className="font-display text-2xl">
          Biggest wins <span className="foil-text">ever</span>
        </h2>
        {rows.length > 1 && <span className="text-xs text-muted lg:hidden">swipe →</span>}
      </div>
      {state === 'loading' ? (
        <div className="-mx-4 flex gap-3 overflow-hidden px-4 lg:mx-0 lg:flex-col lg:px-0" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="panel h-40 w-[78%] shrink-0 animate-pulse sm:w-[46%] lg:h-32 lg:w-auto" />
          ))}
        </div>
      ) : state === 'error' && rows.length === 0 ? (
        <p className="panel p-4 text-sm text-muted">The wall couldn&apos;t load right now.</p>
      ) : rows.length === 0 ? (
        <p className="panel p-4 text-sm text-muted">
          Nothing on the wall yet — the first big hit takes the #1 spot.
        </p>
      ) : (
        <ol className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-3 [scrollbar-width:thin] lg:mx-0 lg:grid lg:grid-cols-1 lg:overflow-visible lg:px-0 lg:pb-0">
          {rows.map((r, i) => (
            <BigCard key={r.ticketId} row={r} rank={i + 1} now={now} />
          ))}
        </ol>
      )}
    </section>
  )
}

function BigCard({ row, rank, now }: { row: WinnerRow; rank: number; now: number }) {
  const jackpot = isJackpotWin(row)
  const podium = rank <= 3
  const frame = jackpot ? JACKPOT_FRAME : podium ? PODIUM_FRAME : 'bg-magenta/25'
  return (
    <li className={`w-[78%] shrink-0 snap-start rounded-2xl p-[2px] sm:w-[46%] lg:w-auto ${frame}`}>
      <div className="flex h-full flex-col gap-2 rounded-[14px] bg-[linear-gradient(180deg,#3a0b5e,#250144)] p-3.5">
        <div className="flex items-start justify-between gap-2">
          <span className={`font-display text-xl leading-none ${podium ? 'foil-text' : 'text-muted'}`}>
            #{rank}
          </span>
          <TierBadges row={row} />
        </div>
        <p className="leading-tight">
          <PumpAmount
            raw={winTotalRaw(row)}
            className={`font-display text-2xl break-all ${podium || jackpot ? 'foil-text' : 'text-ink'}`}
            unitClassName={podium || jackpot ? '' : 'text-gold'}
          />
        </p>
        <UsdAtReveal row={row} />
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-magenta/15 pt-2">
          <Who row={row} />
          <time
            dateTime={row.at}
            title={new Date(row.at).toLocaleString('en-US')}
            className="shrink-0 text-xs text-muted"
          >
            {timeAgo(row.at, now)}
          </time>
        </div>
        <PayoutStatus row={row} />
      </div>
    </li>
  )
}

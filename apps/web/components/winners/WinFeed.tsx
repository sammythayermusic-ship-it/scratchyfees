'use client'

import { AnimatePresence, motion } from 'framer-motion'
import Image from 'next/image'
import Link from 'next/link'
import type { WinnerRow } from '@/lib/types'
import { PayoutStatus, PumpAmount, TierBadges, UsdAtReveal, Who } from './bits'
import { isJackpotWin, JACKPOT_FRAME, timeAgo, winTotalRaw } from './format'

export type FeedRow = WinnerRow & { k: string; live?: boolean }

/** Recent winners, newest first. Live rows slide in from the websocket; older pages load on demand. */
export function WinFeed({
  rows,
  state,
  now,
  connected,
  nextBefore,
  moreState,
  onMore,
  onRetry,
}: {
  rows: FeedRow[]
  state: 'loading' | 'ready' | 'error'
  now: number
  connected: boolean
  nextBefore: string | null
  moreState: 'idle' | 'loading' | 'error'
  onMore: () => void
  onRetry: () => void
}) {
  return (
    <section aria-labelledby="feed-heading" className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 id="feed-heading" className="font-display text-2xl">
          Live feed
        </h2>
        <span className="flex items-center gap-1.5 text-xs text-muted" role="status">
          <span
            className={`h-2 w-2 rounded-full ${connected ? 'animate-pulse bg-pink shadow-[0_0_10px_#fc04a8]' : 'bg-muted/50'}`}
            aria-hidden
          />
          {connected ? 'live' : 'reconnecting…'}
        </span>
      </div>
      <p className="mb-3 text-xs text-muted">
        PUMP amounts are exactly what was paid. ~$ is an estimate at the PUMP price when the ticket was
        revealed.
      </p>

      {state === 'loading' ? (
        <ul className="flex flex-col gap-2" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <li
              key={i}
              className="h-[104px] animate-pulse rounded-2xl border border-magenta/10 bg-stage-2/60"
            />
          ))}
        </ul>
      ) : state === 'error' && rows.length === 0 ? (
        <div className="panel flex flex-col items-center gap-3 p-6 text-center">
          <p className="font-display text-xl">Couldn&apos;t load the winners</p>
          <p className="text-sm text-muted">The feed will pick up live wins as soon as it reconnects.</p>
          <button type="button" className="btn-pink" onClick={onRetry}>
            try again
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="panel flex flex-col items-center gap-3 p-6 text-center">
          <Image
            src="/brand/mascot-sticker.png"
            alt=""
            width={768}
            height={768}
            sizes="128px"
            className="h-28 w-28 animate-float"
          />
          <p className="font-display text-2xl">No winners yet</p>
          <p className="max-w-sm text-sm text-muted">
            The first ticket that hits lands right here — with its Solscan receipt.
          </p>
          <Link href="/" className="btn-gold">
            Go scratch
          </Link>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {rows.map((r) => (
                <motion.li
                  key={r.k}
                  initial={{ opacity: 0, y: -14, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 30 }}
                  className={`rounded-2xl ${isJackpotWin(r) ? `p-[2px] ${JACKPOT_FRAME}` : ''}`}
                >
                  <FeedItem row={r} now={now} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          <div className="mt-4 flex flex-col items-center gap-1 text-sm">
            {nextBefore ? (
              <button type="button" className="btn-ghost" disabled={moreState === 'loading'} onClick={onMore}>
                {moreState === 'loading' ? 'loading…' : 'load older wins'}
              </button>
            ) : (
              <p className="text-xs text-muted">That&apos;s every win so far.</p>
            )}
            {moreState === 'error' && (
              <p className="text-xs text-pink">Couldn&apos;t load more — try again.</p>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function FeedItem({ row, now }: { row: WinnerRow; now: number }) {
  const jackpot = isJackpotWin(row)
  return (
    <div
      className={`flex flex-col gap-2 rounded-2xl px-3.5 py-3 sm:px-4 ${
        jackpot
          ? 'rounded-[14px] bg-[linear-gradient(180deg,#3a0b5e,#250144)]'
          : 'border border-magenta/15 bg-stage-2/55'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <Who row={row} />
        <span className="shrink-0 text-right text-xs text-muted">
          <span className="hidden min-[400px]:inline">round #{row.roundId} · </span>
          <time dateTime={row.at} title={new Date(row.at).toLocaleString('en-US')}>
            {timeAgo(row.at, now)}
          </time>
        </span>
      </div>
      <TierBadges row={row} />
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1.5">
        <p className="min-w-0 leading-none">
          <PumpAmount
            raw={winTotalRaw(row)}
            className={`font-display text-xl break-all ${jackpot ? 'foil-text' : 'text-gold'}`}
            unitClassName={jackpot ? '' : 'text-gold/80'}
          />{' '}
          <UsdAtReveal row={row} className="whitespace-nowrap" />
        </p>
        <PayoutStatus row={row} />
      </div>
    </div>
  )
}

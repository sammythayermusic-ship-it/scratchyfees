'use client'

import { multLabel, usdMicro } from '@/lib/money'
import type { EnterResult } from '@/lib/types'

/** Holdings → tickets per drop → whale multiplier, and the "+$50 more" nudge (PLAN §2.1, §6). */
export function EligibilityCard({ r }: { r: EnterResult }) {
  const n = r.nudge
  const nudge = n.maxed
    ? 'Max multiplier reached — every prize on your tickets is ×25.'
    : BigInt(n.extraTickets) > 0n
      ? `+$${n.extraUsd} more of $SCRATCHY = +${n.extraTickets} tickets every drop`
      : `+$${n.extraUsd} more of $SCRATCHY = +${(Number(BigInt(n.multGainMicro)) / 1e6).toFixed(2)}× on every prize`
  return (
    <div className="panel flex flex-col gap-2 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex gap-5">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted">Holding</p>
          <p className="font-display text-xl">{usdMicro(r.holdingsUsdMicro)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-muted">Tickets / drop</p>
          <p className="font-display text-xl text-gold">{r.eligibleNow ? r.ticketsPerDrop : 0}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-muted">Multiplier</p>
          <p className="font-display text-xl text-magenta">{multLabel(r.multMicro)}</p>
        </div>
      </div>
      <p className="text-muted sm:max-w-[45%] sm:text-right">
        {r.eligibleNow ? nudge : `Hold at least $50 of $SCRATCHY to get tickets. ${nudge}`}
      </p>
    </div>
  )
}

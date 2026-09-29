'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useLiveEvent } from '@/lib/live'
import { fmtPump, fmtUsd, shortWallet, TIER_NAMES } from '@/lib/money'
import type { WinnerRow } from '@/lib/types'

/** Live winners ticker on the home page (full feed on /winners). */
export function RecentWins() {
  const [rows, setRows] = useState<WinnerRow[]>([])
  useEffect(() => {
    api.winners().then(
      (w) => setRows(w.recent.slice(0, 8)),
      () => {},
    )
  }, [])
  useLiveEvent((e) => {
    if (e.type !== 'winner') return
    setRows((r) =>
      [
        {
          ticketId: `${e.roundId}-${e.at}-${Math.random()}`,
          roundId: e.roundId,
          wallet: e.wallet,
          xHandle: e.xHandle,
          tier: e.tier,
          multMicro: null,
          prizeRaw: e.prizeRaw,
          jackpotPrizeRaw: e.jackpotPrizeRaw,
          at: e.at,
          txSig: null,
          payoutStatus: null,
          pumpUsdE18: e.pumpUsdE18,
        },
        ...r,
      ].slice(0, 8),
    )
  })
  return (
    <section className="panel p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-xl">Live winners</h2>
        <Link href="/winners" className="text-sm text-gold hover:underline">
          all winners →
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No wins yet this session — be the first.</p>
      ) : (
        <ul className="divide-y divide-magenta/10">
          {rows.map((r) => {
            const total = BigInt(r.prizeRaw) + BigInt(r.jackpotPrizeRaw)
            return (
              <li key={r.ticketId} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="truncate">
                  <span className="text-ink">{r.xHandle ? `@${r.xHandle}` : shortWallet(r.wallet)}</span>{' '}
                  <span className="text-muted">
                    · {BigInt(r.jackpotPrizeRaw) > 0n ? 'JACKPOT' : TIER_NAMES[r.tier]}
                  </span>
                </span>
                <span className="shrink-0 font-display text-gold">
                  {fmtPump(total)} PUMP{' '}
                  <span className="text-xs text-muted">{fmtUsd(total, r.pumpUsdE18)}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

import type { RoundParams } from '@scratchy/core'
import { Fragment, useState } from 'react'
import { TIER_MULTIPLE, TIER_NAMES } from '@/lib/money'
import { TicketProofView } from './TicketProofView'
import { multExact, pumpExact, type TicketRow } from './verify'

type Filter = 'all' | 'wins' | 'bad'

const tierName = (t: number) => TIER_NAMES[t as 0] ?? `tier ${t}`
const tierMultiple = (t: number) => (t > 0 && TIER_MULTIPLE[t as 0] ? `${TIER_MULTIPLE[t as 0]}×` : '—')
const rowKey = (r: TicketRow) => `${r.wallet}:${r.idx}`

/** What the server recorded, spelled out only where it differs from the recomputation. */
function serverDiff(r: TicketRow): string {
  if (!r.stored) return 'server has no record of this ticket'
  const parts: string[] = []
  if (!r.tierOk) parts.push(tierName(r.stored.tier))
  if (!r.jackpotOk) parts.push(r.stored.jackpot ? 'jackpot hit' : 'no jackpot')
  if (!r.prizeOk) parts.push(`${pumpExact(r.stored.prizeRaw)} PUMP`)
  return `server recorded: ${parts.join(' · ')}`
}

export function TicketTable({
  rows,
  seed,
  params,
  showWallet,
  autoOpen,
}: {
  rows: TicketRow[]
  seed: string
  params: RoundParams
  showWallet: boolean
  /** single-ticket lookups open the derivation straight away */
  autoOpen: boolean
}) {
  const bad = rows.filter((r) => !r.match).length
  const wins = rows.filter((r) => r.recomputed.prizeRaw > 0n || r.recomputed.jackpot).length
  const [filter, setFilter] = useState<Filter>(bad > 0 ? 'bad' : 'all')
  const [open, setOpen] = useState<string | null>(autoOpen && rows[0] ? rowKey(rows[0]) : null)
  const shown = rows.filter((r) =>
    filter === 'bad'
      ? !r.match
      : filter === 'wins'
        ? r.recomputed.prizeRaw > 0n || r.recomputed.jackpot
        : true,
  )
  const filters: [Filter, string, number][] = [
    ['all', 'All', rows.length],
    ['wins', 'Wins', wins],
    ['bad', 'Mismatches', bad],
  ]

  return (
    <div className="mt-3">
      {rows.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Filter tickets">
          {filters.map(([f, label, n]) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                filter === f
                  ? f === 'bad' && n > 0
                    ? 'border-red-400 bg-red-500/25 text-red-100'
                    : 'border-gold/70 bg-gold/15 text-gold'
                  : f === 'bad' && n > 0
                    ? 'border-red-400/60 text-red-300'
                    : 'border-muted/30 text-muted hover:text-ink'
              }`}
            >
              {label} <span className="tabular-nums opacity-80">{n.toLocaleString('en-US')}</span>
            </button>
          ))}
        </div>
      )}
      <div className="-mx-4 overflow-x-auto sm:mx-0">
        <table className="w-full min-w-[320px] border-separate border-spacing-0 text-left text-sm">
          <caption className="sr-only">
            Recomputed tickets compared with the server&apos;s records. Select a ticket number to see its
            derivation.
          </caption>
          <thead className="text-[11px] uppercase tracking-wider text-muted">
            <tr>
              <th scope="col" className="py-2 pl-4 pr-2 font-semibold sm:pl-2">
                #
              </th>
              <th scope="col" className="px-2 py-2 font-semibold">
                Tier
              </th>
              <th scope="col" className="hidden px-2 py-2 text-right font-semibold sm:table-cell">
                Multiple
              </th>
              <th scope="col" className="px-2 py-2 text-right font-semibold">
                Prize (PUMP)
              </th>
              <th scope="col" className="py-2 pl-2 pr-4 text-center font-semibold sm:pr-2">
                Match
              </th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted">
                  {filter === 'bad' ? 'No mismatches — every ticket matches.' : 'No winning tickets here.'}
                </td>
              </tr>
            )}
            {shown.map((r, i) => {
              const k = rowKey(r)
              const isOpen = open === k
              const newWallet = showWallet && (i === 0 || shown[i - 1]!.wallet !== r.wallet)
              const t = r.recomputed.tier
              const win = r.recomputed.prizeRaw > 0n
              const cell = `border-t ${r.match ? 'border-magenta/10' : 'border-red-500/40'}`
              return (
                <Fragment key={k}>
                  {newWallet && (
                    <tr>
                      <th
                        scope="rowgroup"
                        colSpan={5}
                        className="border-t border-gold/25 bg-stage/60 px-4 py-1.5 text-left font-normal sm:px-2"
                      >
                        <span className="break-all font-mono text-[11px] text-gold">{r.wallet}</span>
                        <span className="text-[11px] text-muted"> · mult {multExact(r.multMicro)}</span>
                      </th>
                    </tr>
                  )}
                  <tr className={r.match ? (isOpen ? 'bg-stage-3/40' : '') : 'bg-red-600/20'}>
                    <td
                      className={`${cell} py-2 pl-4 pr-2 align-top sm:pl-2 ${r.match ? '' : 'border-l-4 border-l-red-500'}`}
                    >
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-label={`Ticket ${r.idx}${showWallet ? ` of ${r.wallet}` : ''}: show derivation`}
                        onClick={() => setOpen(isOpen ? null : k)}
                        className="font-display text-base text-ink underline decoration-magenta/50 decoration-dotted underline-offset-4 hover:text-gold"
                      >
                        #{r.idx}
                      </button>
                    </td>
                    <td className={`${cell} px-2 py-2 align-top`}>
                      <span className={win ? 'font-semibold text-ink' : 'text-muted'}>{tierName(t)}</span>
                      <span className="text-xs text-muted sm:hidden"> · {tierMultiple(t)}</span>
                      {r.recomputed.jackpot && (
                        <span className="ml-1 inline-block rounded-full bg-gradient-to-r from-pink to-gold px-2 py-0.5 text-[10px] font-bold uppercase text-stage">
                          jackpot roll
                        </span>
                      )}
                      {r.stored?.void && (
                        <span
                          className="ml-1 inline-block rounded-full border border-muted/40 px-1.5 text-[10px] uppercase text-muted"
                          title="Not scratched before the round ended — forfeited, but its outcome is still verifiable"
                        >
                          void
                        </span>
                      )}
                      {!r.match && (
                        <span className="block text-xs font-semibold text-red-300">{serverDiff(r)}</span>
                      )}
                    </td>
                    <td className={`${cell} hidden px-2 py-2 text-right align-top text-muted sm:table-cell`}>
                      {tierMultiple(t)}
                    </td>
                    <td
                      className={`${cell} px-2 py-2 text-right align-top font-mono ${win ? 'text-gold' : 'text-muted'}`}
                    >
                      {pumpExact(r.recomputed.prizeRaw)}
                    </td>
                    <td className={`${cell} py-2 pl-2 pr-4 text-center align-top text-base sm:pr-2`}>
                      <span role="img" aria-label={r.match ? 'matches' : 'does not match'}>
                        {r.match ? '✅' : '❌'}
                      </span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={5} className="border-t border-magenta/10 px-4 pb-4 pt-2 sm:px-2">
                        <TicketProofView row={r} seed={seed} params={params} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

import type { ReactNode } from 'react'
import { fmtPump, fmtUsd } from '@/lib/money'
import type { WinnersStats } from './format'

/** Aggregate numbers from /api/stats. Totals are exact PUMP; "~$" uses today's PUMP price (estimate). */
export function WinnerStats({
  stats,
  state,
  price,
  onRetry,
}: {
  stats: WinnersStats | null
  state: 'loading' | 'ready' | 'error'
  price: string | null
  onRetry: () => void
}) {
  if (state === 'error' && !stats) {
    return (
      <div className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
        <p className="text-muted">Couldn&apos;t load the all-time stats.</p>
        <button type="button" className="btn-ghost text-sm" onClick={onRetry}>
          try again
        </button>
      </div>
    )
  }
  const today = (raw: string) => {
    if (BigInt(raw) === 0n) return 'nothing yet — first win lands here'
    const usd = fmtUsd(raw, price)
    return usd ? `${usd} at today’s price` : 'no $ estimate right now'
  }
  const recent = stats?.poolHistory.filter((r) => r.status !== 'skipped') ?? []
  const recentTickets = recent.reduce((s, r) => s + r.tickets, 0)
  return (
    <section aria-label="All-time stats">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Paid out, all time"
          loading={!stats}
          title={stats ? `${fmtPump(stats.totalPaidRaw)} PUMP` : undefined}
        >
          {stats && (
            <>
              <Big>{fmtPump(stats.totalPaidRaw)}</Big>
              <Sub>{today(stats.totalPaidRaw)}</Sub>
            </>
          )}
        </Tile>
        <Tile label="Wins paid" loading={!stats}>
          {stats && (
            <>
              <p className="font-display text-xl text-ink sm:text-3xl">
                {stats.payoutCount.toLocaleString('en-US')}
              </p>
              <Sub>payouts confirmed on-chain</Sub>
            </>
          )}
        </Tile>
        <Tile label="Biggest single win" loading={!stats} accent>
          {stats && (
            <>
              <Big foil>{fmtPump(stats.biggestWinRaw)}</Big>
              <Sub>{today(stats.biggestWinRaw)}</Sub>
            </>
          )}
        </Tile>
        <Tile label="Fees into the prize pool" loading={!stats}>
          {stats && (
            <>
              <Big>{fmtPump(stats.sweptToPoolRaw)}</Big>
              <Sub>{fmtPump(stats.sweptToOpsRaw)} PUMP went to operations</Sub>
            </>
          )}
        </Tile>
      </div>
      {recent.length > 0 && (
        <p className="mt-2 text-center text-xs text-muted">
          {recentTickets.toLocaleString('en-US')} {recentTickets === 1 ? 'ticket' : 'tickets'} dropped across
          the last {recent.length === 1 ? 'round' : `${recent.length} rounds`} · amounts are exact PUMP · ~$
          is an estimate
        </p>
      )}
    </section>
  )
}

function Tile({
  label,
  loading,
  accent,
  title,
  children,
}: {
  label: string
  loading: boolean
  accent?: boolean
  title?: string
  children: ReactNode
}) {
  return (
    <div className="panel relative min-w-0 overflow-hidden px-4 py-3" title={title}>
      {accent && (
        <span
          aria-hidden
          className="absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-gold to-transparent"
        />
      )}
      <p className={`text-[11px] uppercase tracking-[0.18em] ${accent ? 'text-gold' : 'text-muted'}`}>
        {label}
      </p>
      {loading ? (
        <div className="mt-2 space-y-2" aria-hidden>
          <div className="h-7 w-3/4 animate-pulse rounded-lg bg-stage-3/80" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-stage-3/60" />
        </div>
      ) : (
        <div className="mt-1">{children}</div>
      )}
    </div>
  )
}

function Big({ children, foil }: { children: ReactNode; foil?: boolean }) {
  return (
    <p className="font-display flex flex-wrap items-baseline gap-x-1.5 text-xl tabular-nums sm:text-3xl">
      <span className={`min-w-0 break-all ${foil ? 'foil-text' : 'text-ink'}`}>{children}</span>
      <span className={`text-sm ${foil ? 'foil-text' : 'text-gold'}`}>PUMP</span>
    </p>
  )
}

function Sub({ children }: { children: ReactNode }) {
  return <p className="mt-0.5 text-xs leading-snug text-muted">{children}</p>
}

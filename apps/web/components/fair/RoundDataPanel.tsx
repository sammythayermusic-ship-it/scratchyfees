import { budgetFromParams } from '@scratchy/core'
import { API_ORIGIN } from '@/lib/config'
import { CopyButton } from './CopyButton'
import type { Report } from './load'
import { groupBig, multExact, ppmPercent, pumpExact, pythonCheck } from './verify'

interface Item {
  label: string
  hint?: string
  display: string
  /** the exact raw value a skeptic would paste into their own script */
  copy: string | null
}

const shortHex = (h: string) => (h.length > 24 ? `${h.slice(0, 12)}…${h.slice(-10)}` : h)

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' })

/** Every input the verification used, raw and copyable, so it can be reproduced offline. */
export function RoundDataPanel({ report }: { report: Report }) {
  const r = report.fair.round
  const b = report.params ? budgetFromParams(report.params) : null
  const pump = (raw: string | null) => (raw === null ? '—' : `${pumpExact(raw)} PUMP`)
  const totalTickets = report.fair.entries.reduce((s, e) => s + e.tickets, 0)
  const items: Item[] = [
    {
      label: 'Seed hash',
      hint: 'committed before the round',
      display: shortHex(r.seedHash),
      copy: r.seedHash,
    },
    {
      label: 'Server seed',
      hint: 'revealed at round end',
      display: r.serverSeed ? shortHex(r.serverSeed) : 'not revealed yet',
      copy: r.serverSeed,
    },
    {
      label: 'P · pool snapshot',
      hint: 'taken when the round started',
      display: pump(r.poolRaw),
      copy: r.poolRaw,
    },
    {
      label: 'Payout rate',
      display: r.payoutRatePpm === null ? '—' : `${ppmPercent(r.payoutRatePpm)} of P`,
      copy: r.payoutRatePpm,
    },
    { label: 'B · round budget', hint: 'P × payout rate', display: pump(r.budgetRaw), copy: r.budgetRaw },
    {
      label: 'Jackpot share',
      hint: 'of B, to the progressive pot',
      display:
        r.jackpotSharePpm === null
          ? '—'
          : `${ppmPercent(r.jackpotSharePpm)} = ${pump(r.jackpotAccrualRaw ?? (b ? b.jackpotAccrualRaw.toString() : null))}`,
      copy: r.jackpotSharePpm,
    },
    {
      label: 'Ticket budget',
      hint: 'B − jackpot share',
      display: pump(r.ticketBudgetRaw),
      copy: r.ticketBudgetRaw,
    },
    {
      label: 'Single-prize cap',
      hint: r.singlePrizeCapPpm === null ? undefined : `P × ${ppmPercent(r.singlePrizeCapPpm)}`,
      display: pump(r.singlePrizeCapRaw),
      copy: r.singlePrizeCapRaw,
    },
    {
      label: 'W · total weight',
      hint: 'Σ tickets × mult, micro-units',
      display: r.totalWeightedMicro === null ? '—' : `${groupBig(r.totalWeightedMicro)} µ`,
      copy: r.totalWeightedMicro,
    },
    {
      label: 'Jackpot odds',
      display: r.jackpotOdds === null ? '—' : `1 in ${groupBig(r.jackpotOdds)}`,
      copy: r.jackpotOdds,
    },
    {
      label: 'Entries',
      display: `${report.fair.entries.length.toLocaleString('en-US')} wallets · ${totalTickets.toLocaleString('en-US')} tickets`,
      copy: null,
    },
  ]
  if (report.entry) {
    items.push({
      label: 'Your multiplier',
      hint: `${report.entry.tickets} tickets`,
      display: multExact(report.entry.multMicro),
      copy: report.entry.multMicro,
    })
  }

  const json = JSON.stringify(
    {
      roundId: r.id,
      status: r.status,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      seedHash: r.seedHash,
      serverSeed: r.serverSeed,
      poolRaw: r.poolRaw,
      payoutRatePpm: r.payoutRatePpm,
      jackpotSharePpm: r.jackpotSharePpm,
      singlePrizeCapPpm: r.singlePrizeCapPpm,
      jackpotOdds: r.jackpotOdds,
      totalWeightedMicro: r.totalWeightedMicro,
      budgetRaw: r.budgetRaw,
      ticketBudgetRaw: r.ticketBudgetRaw,
      jackpotAccrualRaw: r.jackpotAccrualRaw,
      singlePrizeCapRaw: r.singlePrizeCapRaw,
      entries: report.fair.entries.map((e) => ({
        wallet: e.wallet,
        tickets: e.tickets,
        multMicro: e.multMicro,
      })),
    },
    null,
    2,
  )
  const canScript =
    r.serverSeed !== null &&
    r.poolRaw !== null &&
    r.payoutRatePpm !== null &&
    r.jackpotSharePpm !== null &&
    r.singlePrizeCapPpm !== null &&
    r.jackpotOdds !== null &&
    r.totalWeightedMicro !== null
  const script = canScript
    ? pythonCheck({
        roundId: r.id,
        serverSeed: r.serverSeed!,
        seedHash: r.seedHash,
        poolRaw: r.poolRaw!,
        payoutRatePpm: r.payoutRatePpm!,
        jackpotSharePpm: r.jackpotSharePpm!,
        singlePrizeCapPpm: r.singlePrizeCapPpm!,
        jackpotOdds: r.jackpotOdds!,
        totalWeightedMicro: r.totalWeightedMicro!,
        entries: report.checkedEntries,
      })
    : null

  const raw = `${API_ORIGIN}/api/fair/${r.id}`
  const rawTickets = report.query.wallet
    ? `${API_ORIGIN}/api/fair/${r.id}/tickets?wallet=${encodeURIComponent(report.query.wallet)}`
    : null

  return (
    <section className="panel p-4 sm:p-6" aria-labelledby="round-data-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="round-data-heading" className="font-display text-2xl">
            Round data used
          </h3>
          <p className="text-sm text-muted">
            Round #{r.id} · {r.status} · {when(r.startsAt)} → {when(r.endsAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <CopyButton value={json} label="Copy all round data as JSON" text="copy JSON" />
          {script && (
            <CopyButton
              value={script}
              label="Copy a Python script prefilled with this round"
              text="copy Python check"
            />
          )}
        </div>
      </div>

      <dl className="mt-3 grid gap-x-6 sm:grid-cols-2">
        {items.map((it) => (
          <div
            key={it.label}
            className="flex items-center justify-between gap-2 border-b border-magenta/10 py-2"
          >
            <div className="min-w-0">
              <dt className="text-xs uppercase tracking-[0.12em] text-muted">
                {it.label}
                {it.hint && (
                  <span className="ml-1 normal-case tracking-normal text-muted/70">· {it.hint}</span>
                )}
              </dt>
              <dd className="break-all font-mono text-sm text-ink">
                {it.display}
                {it.copy !== null && it.display !== '—' && it.copy.length < 40 && (
                  <span className="block text-[11px] text-muted">raw {it.copy}</span>
                )}
              </dd>
            </div>
            {it.copy !== null && <CopyButton value={it.copy} label={`Copy ${it.label}`} />}
          </div>
        ))}
      </dl>

      <p className="mt-3 text-xs text-muted">
        Amounts are raw PUMP base units (6 decimals); rates are parts-per-million; multipliers are
        micro-units. Raw JSON:{' '}
        <a className="break-all text-gold hover:underline" href={raw} target="_blank" rel="noreferrer">
          {raw}
        </a>
        {rawTickets && (
          <>
            {' · '}
            <a
              className="break-all text-gold hover:underline"
              href={rawTickets}
              target="_blank"
              rel="noreferrer"
            >
              tickets for this wallet
            </a>
          </>
        )}
        {script && report.mode === 'sample' && (
          <>
            {' '}
            · The Python check covers the {report.checkedEntries.length.toLocaleString('en-US')} wallet
            {report.checkedEntries.length === 1 ? '' : 's'} checked so far.
          </>
        )}
      </p>
    </section>
  )
}

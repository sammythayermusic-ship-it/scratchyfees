import { shortWallet } from '@/lib/money'
import { CopyButton } from './CopyButton'
import type { Report } from './load'
import { RoundDataPanel } from './RoundDataPanel'
import { TicketTable } from './TicketTable'
import { groupBig, pumpExact, summarize, type TicketSummary, type ValueCheck } from './verify'

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

const Mark = ({ ok, label }: { ok: boolean; label?: string }) => (
  <span role="img" aria-label={label ?? (ok ? 'matches' : 'does not match')}>
    {ok ? '✅' : '❌'}
  </span>
)

function problems(report: Report, s: TicketSummary): string[] {
  const out: string[] = []
  if (report.seedCheck.status === 'mismatch')
    out.push('The revealed seed does NOT hash to the committed value.')
  if (report.seedCheck.status === 'malformed') out.push('The revealed seed is not 32 bytes of hex.')
  if (report.missingParams.length > 0)
    out.push(`The round is missing stored parameters: ${report.missingParams.join(', ')}.`)
  const badMath = report.mathChecks.filter((c) => c.status === 'mismatch')
  if (badMath.length > 0)
    out.push(`${badMath.length} round value(s) don't follow from the round's own parameters.`)
  if (s.mismatched > 0)
    out.push(
      `${s.mismatched.toLocaleString('en-US')} of ${plural(s.total, 'ticket')} ${s.mismatched === 1 ? "doesn't" : "don't"} match what the server recorded.`,
    )
  out.push(...report.issues.map((i) => i.charAt(0).toUpperCase() + i.slice(1) + '.'))
  return out
}

export function ReportView({
  report,
  onLoadMore,
  moreBusy,
  moreError,
}: {
  report: Report
  onLoadMore: () => void
  moreBusy: boolean
  moreError: string | null
}) {
  const r = report.fair.round
  const s = summarize(report.rows)
  const bad = problems(report, s)
  const pass = bad.length === 0
  const skipped = r.status === 'skipped'
  const noTickets = skipped || report.fair.entries.length === 0
  const walletMissing = report.mode === 'wallet' && !report.entry && !noTickets

  let headline: string
  let sub: string
  if (!pass) {
    headline = 'Verification FAILED'
    sub = `Round #${r.id} did not check out. Here's what doesn't add up:`
  } else if (noTickets) {
    headline = `Round #${r.id}: seed verified`
    sub = skipped
      ? `The round was skipped${r.skipReason ? ` (${r.skipReason.replace(/_/g, ' ')})` : ''} — no tickets were issued, but its commitment still checks out.`
      : 'Nobody entered this round, so no tickets were issued — but its commitment still checks out.'
  } else if (walletMissing) {
    headline = `Round #${r.id}: seed verified`
    sub = `${shortWallet(report.query.wallet!)} had no entry in this round, so there are no tickets to check. Clear the wallet to spot-check everyone's tickets.`
  } else {
    headline = `Round #${r.id} checks out`
    const scope =
      report.mode === 'wallet'
        ? report.query.ticketIdx !== null
          ? `ticket #${report.query.ticketIdx} of ${shortWallet(report.query.wallet!)}`
          : `all ${s.total.toLocaleString('en-US')} of ${shortWallet(report.query.wallet!)}'s tickets`
        : report.nextCursor === null
          ? `all ${s.total.toLocaleString('en-US')} tickets in the round (every wallet)`
          : `all ${s.total.toLocaleString('en-US')} tickets checked so far (${plural(report.checkedEntries.length, 'wallet')} of ${report.fair.entries.length.toLocaleString('en-US')})`
    sub = `The seed matches its commitment and ${scope} recomputed in your browser match${s.total === 1 ? 'es' : ''} the server's records exactly.`
  }

  return (
    <>
      <section
        role={pass ? 'status' : 'alert'}
        className={`relative overflow-hidden rounded-[1.25rem] border-2 p-4 [overflow-wrap:anywhere] sm:p-6 ${
          pass
            ? 'border-emerald-400/50 bg-emerald-400/10 shadow-[0_0_40px_-12px_rgba(52,211,153,0.6)]'
            : 'border-red-500 bg-red-600/25 shadow-[0_0_60px_-6px_rgba(239,68,68,0.9)]'
        }`}
      >
        {!pass && (
          // pulse a glow layer, never the text itself
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 animate-pulse-glow shadow-[inset_0_0_50px_rgba(239,68,68,0.65)]"
          />
        )}
        <p className={`font-display text-3xl sm:text-4xl ${pass ? 'text-emerald-200' : 'text-red-100'}`}>
          <span aria-hidden>{pass ? '✅ ' : '❌ '}</span>
          {headline}
        </p>
        <p className={`mt-1 ${pass ? 'text-emerald-100/80' : 'text-red-100'}`}>{sub}</p>
        {!pass && (
          <ul className="mt-2 list-disc pl-5 font-semibold text-red-100">
            {bad.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <SeedCard report={report} />
        <MathCard checks={report.mathChecks} missing={report.missingParams} />
      </div>

      {!noTickets && !walletMissing && report.params && (
        <section className="panel p-4 sm:p-6" aria-labelledby="tickets-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="tickets-heading" className="font-display text-2xl">
              <span className="text-muted">3 ·</span> Tickets
            </h3>
            <p
              className={`font-display text-lg ${s.mismatched === 0 && s.total > 0 ? 'text-emerald-300' : 'text-red-300'}`}
            >
              {s.total === 0
                ? 'No tickets checked'
                : s.mismatched === 0
                  ? s.total === 1
                    ? '✅ matches'
                    : `✅ all ${s.total.toLocaleString('en-US')} match`
                  : `❌ ${s.mismatched.toLocaleString('en-US')} of ${s.total.toLocaleString('en-US')} don't match`}
            </p>
          </div>
          <p className="mt-1 text-sm text-muted">
            {s.wins.toLocaleString('en-US')} winning ticket{s.wins === 1 ? '' : 's'} ·{' '}
            <span className="text-gold">{pumpExact(s.totalPrizeRaw)} PUMP</span> in tier prizes
            {s.jackpots > 0 ? ` · ${s.jackpots} jackpot roll${s.jackpots === 1 ? '' : 's'} hit` : ''}. Tap a
            ticket # to see the full derivation.
          </p>
          <TicketTable
            rows={report.rows}
            seed={report.seed}
            params={report.params}
            showWallet={report.mode === 'sample'}
            autoOpen={report.query.ticketIdx !== null}
          />
          {report.mode === 'sample' && (
            <div className="mt-4 flex flex-col items-center gap-2 text-center">
              <p className="text-xs text-muted">
                Checked {report.checkedEntries.length.toLocaleString('en-US')} of{' '}
                {plural(report.fair.entries.length, 'wallet')} in this round.
              </p>
              {report.nextCursor !== null && (
                <button type="button" className="btn-pink" onClick={onLoadMore} disabled={moreBusy}>
                  {moreBusy ? 'Checking…' : 'Check the next wallets'}
                </button>
              )}
              {moreError && <p className="text-sm text-red-300">{moreError}</p>}
            </div>
          )}
        </section>
      )}

      <RoundDataPanel report={report} />
    </>
  )
}

function HashLine({ label, value, tone = 'text-ink' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-magenta/20 bg-stage/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
        <CopyButton value={value} label={`Copy ${label}`} />
      </div>
      <p className={`mt-1 break-all font-mono text-[13px] leading-snug ${tone}`}>{value}</p>
    </div>
  )
}

function SeedCard({ report }: { report: Report }) {
  const r = report.fair.round
  const c = report.seedCheck
  const ok = c.status === 'match'
  return (
    <section
      className={`panel p-4 sm:p-6 ${ok ? '' : 'border-red-500 bg-red-900/30'}`}
      aria-labelledby="seed-heading"
    >
      <h3 id="seed-heading" className="font-display text-2xl">
        <span className="text-muted">1 ·</span> Seed commitment <Mark ok={ok} />
      </h3>
      <p className="mt-1 text-sm text-muted">
        sha256(revealed seed) must equal the hash published before round #{r.id} started.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <HashLine label="Committed hash" value={r.seedHash} />
        <HashLine
          label="sha256(seed) · computed here"
          value={c.computedHash ?? 'could not hash — seed is malformed'}
          tone={ok ? 'text-emerald-200' : 'text-red-300'}
        />
        <HashLine label="Revealed seed" value={report.seed} tone="text-gold" />
      </div>
    </section>
  )
}

function MathCard({ checks, missing }: { checks: ValueCheck[]; missing: string[] }) {
  const ok = missing.length === 0 && checks.every((c) => c.status !== 'mismatch')
  return (
    <section
      className={`panel p-4 sm:p-6 ${ok ? '' : 'border-red-500 bg-red-900/30'}`}
      aria-labelledby="math-check-heading"
    >
      <h3 id="math-check-heading" className="font-display text-2xl">
        <span className="text-muted">2 ·</span> Round math <Mark ok={ok} />
      </h3>
      <p className="mt-1 text-sm text-muted">
        The stored budget and cap must follow from the pool snapshot P and the round&apos;s own rates.
      </p>
      {missing.length > 0 ? (
        <p className="mt-3 font-semibold text-red-300">Missing stored parameters: {missing.join(', ')}.</p>
      ) : (
        <ul className="mt-3 divide-y divide-magenta/10 text-sm">
          {checks.map((c) => (
            <li key={c.key} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-ink">{c.label}</p>
                <p className="break-all font-mono text-xs text-muted">
                  {c.recomputed === null
                    ? (c.note ?? 'not enough published data to recompute')
                    : c.key === 'totalWeight'
                      ? `${groupBig(c.recomputed)} µ`
                      : `${pumpExact(c.recomputed)} PUMP`}
                  {c.status === 'mismatch' && c.stored !== null && (
                    <span className="block text-red-300">
                      server stored{' '}
                      {c.key === 'totalWeight' ? `${groupBig(c.stored)} µ` : `${pumpExact(c.stored)} PUMP`}
                    </span>
                  )}
                </p>
              </div>
              <span className="shrink-0 pt-0.5">
                {c.status === 'unavailable' ? (
                  <span className="text-xs text-muted">n/a</span>
                ) : (
                  <Mark ok={c.status === 'match'} />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

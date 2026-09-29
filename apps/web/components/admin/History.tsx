'use client'

import { useState } from 'react'
import { ago, fmtScaled, fmtTime, fmtWeighted, ppmToPercent, share } from './format'
import type { AdminRound, AdminStatus, Severity } from './types'
import { Card, Empty, Pill, Pump, tdCls, thCls, Tx, type Tone } from './ui'

/** Recent rounds, sweeps and ops events (newest first, as the API returns them). */

const ROUND_TONE: Record<string, Tone> = { live: 'ok', pending: 'muted', ended: 'info', skipped: 'warn' }

function Breaker({ r }: { r: AdminRound }) {
  if (r.breakerVerified === 'mismatch') return <Pill tone="bad">mismatch</Pill>
  if (r.breakerTripped) {
    if (r.breakerVerified === 'ok') return <Pill tone="warn">tripped · verified ok</Pill>
    return <Pill tone="bad">tripped · unverified</Pill>
  }
  return <span className="text-muted">—</span>
}

export function RecentRounds({ status }: { status: AdminStatus }) {
  const rows = status.rounds
  return (
    <Card title="Recent rounds" right={<span>P pool · B budget · W weighted tickets</span>}>
      {rows.length === 0 ? (
        <Empty>No rounds yet.</Empty>
      ) : (
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <thead>
              <tr className="border-b border-magenta/20">
                <th className={thCls}>#</th>
                <th className={thCls}>status</th>
                <th className={thCls}>starts</th>
                <th className={`${thCls} text-right`}>P</th>
                <th className={`${thCls} text-right`}>B</th>
                <th className={`${thCls} text-right`}>W</th>
                <th className={`${thCls} text-right`}>entrants</th>
                <th className={`${thCls} text-right`}>tickets</th>
                <th className={`${thCls} text-right`}>realized</th>
                <th className={thCls}>breaker</th>
                <th className={thCls}>rate · price</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-magenta/10 last:border-b-0">
                  <td className={`${tdCls} font-display text-ink`}>{r.id}</td>
                  <td className={tdCls}>
                    <Pill tone={ROUND_TONE[r.status] ?? 'muted'}>{r.status}</Pill>
                    {r.skipReason ? <span className="ml-1 text-xs text-gold">{r.skipReason}</span> : null}
                  </td>
                  <td className={`${tdCls} text-muted`} title={`${r.startsAt} → ${r.endsAt}`}>
                    {fmtTime(r.startsAt)}
                  </td>
                  <td className={`${tdCls} text-right`}>
                    <Pump raw={r.poolRaw} unit={false} />
                  </td>
                  <td className={`${tdCls} text-right`}>
                    <Pump raw={r.budgetRaw} unit={false} />
                  </td>
                  <td className={`${tdCls} text-right`} title={r.totalWeightedMicro ?? undefined}>
                    {fmtWeighted(r.totalWeightedMicro)}
                  </td>
                  <td className={`${tdCls} text-right`}>{r.entrantCount}</td>
                  <td className={`${tdCls} text-right`}>{r.ticketCount}</td>
                  <td className={`${tdCls} text-right`}>
                    <Pump raw={r.realizedRaw} unit={false} />
                    {r.budgetRaw && BigInt(r.budgetRaw) > 0n ? (
                      <span className="block text-[11px] text-muted">
                        {share(r.realizedRaw, r.budgetRaw)} of B
                      </span>
                    ) : null}
                  </td>
                  <td className={tdCls}>
                    <Breaker r={r} />
                  </td>
                  <td className={`${tdCls} text-xs text-muted`}>
                    {r.payoutRatePpm ? ppmToPercent(r.payoutRatePpm) : '—'}
                    {r.priceState ? ` · ${r.priceState}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

const SWEEP_TONE: Record<string, Tone> = {
  done: 'ok',
  failed: 'bad',
  claimed: 'info',
  swapped: 'info',
  split: 'info',
}
const scr = (raw: string) => `${fmtScaled(raw, 6, 2)} SCRATCHY`

export function RecentSweeps({ status }: { status: AdminStatus }) {
  const rows = status.sweeps
  return (
    <Card title="Recent sweeps" right={<span>claim → swap → 70/30 split</span>}>
      {rows.length === 0 ? (
        <Empty>No sweeps yet.</Empty>
      ) : (
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-magenta/20">
                <th className={thCls}>#</th>
                <th className={thCls}>status</th>
                <th className={thCls}>at</th>
                <th className={`${thCls} text-right`}>claimed</th>
                <th className={`${thCls} text-right`}>swap</th>
                <th className={`${thCls} text-right`}>total PUMP</th>
                <th className={`${thCls} text-right`}>→ PRIZE</th>
                <th className={`${thCls} text-right`}>→ OPS</th>
                <th className={thCls}>txs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-b border-magenta/10 align-top last:border-b-0">
                  <td className={`${tdCls} font-display text-ink`}>{s.id}</td>
                  <td className={tdCls}>
                    <Pill tone={SWEEP_TONE[s.status] ?? 'muted'}>{s.status}</Pill>
                  </td>
                  <td className={`${tdCls} text-muted`} title={`updated ${s.updatedAt}`}>
                    {fmtTime(s.at)}
                  </td>
                  <td className={`${tdCls} text-right`}>
                    <Pump raw={s.claimedPumpRaw} />
                    {BigInt(s.claimedScratchyRaw) > 0n ? (
                      <span className="block text-[11px] text-muted">+ {scr(s.claimedScratchyRaw)}</span>
                    ) : null}
                  </td>
                  <td className={`${tdCls} text-right`}>
                    {BigInt(s.swapInScratchyRaw) > 0n || BigInt(s.swapOutPumpRaw) > 0n ? (
                      <>
                        <span className="text-muted">{scr(s.swapInScratchyRaw)} →</span>
                        <span className="block">
                          <Pump raw={s.swapOutPumpRaw} />
                        </span>
                      </>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className={`${tdCls} text-right`}>
                    <Pump raw={s.totalPumpRaw} />
                  </td>
                  <td className={`${tdCls} text-right`}>
                    <Pump raw={s.toPrizeRaw} />
                    <span className="block text-[11px] text-muted">
                      {share(s.toPrizeRaw, s.totalPumpRaw)}
                    </span>
                  </td>
                  <td className={`${tdCls} text-right`}>
                    <Pump raw={s.toOpsRaw} />
                    <span className="block text-[11px] text-muted">{share(s.toOpsRaw, s.totalPumpRaw)}</span>
                  </td>
                  <td className={`${tdCls} text-xs`}>
                    {s.txSigs.length === 0 && !s.swapSig ? <span className="text-muted">—</span> : null}
                    {s.txSigs.map((sig) => (
                      <span key={sig} className="block">
                        <Tx sig={sig} cluster={status.cluster} />
                      </span>
                    ))}
                    {s.swapSig && !s.txSigs.includes(s.swapSig) ? (
                      <span className="block">
                        swap <Tx sig={s.swapSig} cluster={status.cluster} />
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows
        .filter((s) => s.error)
        .map((s) => (
          <p
            key={`err-${s.id}`}
            className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-red-500/10 px-2 py-1.5 font-mono text-xs text-red-200"
          >
            sweep #{s.id}: {s.error}
          </p>
        ))}
    </Card>
  )
}

const SEV_TONE: Record<Severity, Tone> = { critical: 'bad', warn: 'warn', info: 'info' }
const SEV_BORDER: Record<Severity, string> = {
  critical: 'border-l-red-400 bg-red-500/10',
  warn: 'border-l-gold bg-gold/5',
  info: 'border-l-violet/60 bg-stage/40',
}
const GROUPS = ['breaker', 'pause', 'resume', 'invariant', 'sweep', 'payout'] as const
type SevFilter = 'all' | Severity

export function RecentEvents({ status, now }: { status: AdminStatus; now: number }) {
  const [sev, setSev] = useState<SevFilter>('all')
  const [group, setGroup] = useState<string>('all')
  const rows = status.events.filter(
    (e) => (sev === 'all' || e.severity === sev) && (group === 'all' || e.kind.startsWith(`${group}.`)),
  )
  const chip = (active: boolean) =>
    `rounded-full border px-2.5 py-1 text-[11px] font-bold ${
      active ? 'border-gold bg-gold/15 text-gold' : 'border-muted/30 text-muted hover:text-ink'
    }`

  return (
    <Card
      title="Recent events"
      right={<span>newest 100 · breaker / pause / resume / invariant / sweep / payout failures</span>}
    >
      <div className="mb-3 flex flex-wrap gap-1">
        {(['all', 'critical', 'warn', 'info'] as const).map((s) => (
          <button key={s} type="button" className={chip(sev === s)} onClick={() => setSev(s)}>
            {s} {s === 'all' ? status.events.length : status.events.filter((e) => e.severity === s).length}
          </button>
        ))}
        <span className="mx-1 self-center text-muted/50">|</span>
        {(['all', ...GROUPS] as const).map((g) => (
          <button key={g} type="button" className={chip(group === g)} onClick={() => setGroup(g)}>
            {g}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <Empty>No events{sev !== 'all' || group !== 'all' ? ' match this filter' : ''}.</Empty>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((e) => (
            <li
              key={e.id}
              className={`rounded-r-xl border-l-4 px-3 py-2 ${SEV_BORDER[e.severity] ?? SEV_BORDER.info}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Pill tone={SEV_TONE[e.severity] ?? 'muted'}>{e.severity}</Pill>
                <span className="font-mono text-ink">{e.kind}</span>
                <span className="text-muted" title={e.at}>
                  {fmtTime(e.at)} {now ? `· ${ago(e.at, now)}` : ''}
                </span>
                <span className="ml-auto font-mono text-muted/70">#{e.id}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{e.message}</p>
              {e.data !== null && e.data !== undefined ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-muted hover:text-ink">data</summary>
                  <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-stage/70 p-2 font-mono text-[11px] text-muted">
                    {JSON.stringify(e.data, null, 2)}
                  </pre>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

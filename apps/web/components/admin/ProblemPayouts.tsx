'use client'

import { useState } from 'react'
import type { ConfirmSpec } from './ConfirmDialog'
import { adminPost } from './client'
import { ago, fmtTime } from './format'
import type { AdminPayout, AdminStatus, PayoutStatus } from './types'
import { Addr, btnSmall, Card, Empty, Pill, Pump, Tx, type Tone } from './ui'

/** held / failed / failed_permanent / sending payouts (newest 100) with Retry for the failed ones. */

const STATUS_TONE: Partial<Record<PayoutStatus, Tone>> = {
  held: 'warn',
  sending: 'info',
  failed: 'bad',
  failed_permanent: 'bad',
}
const FILTERS = ['all', 'failed', 'failed_permanent', 'held', 'sending'] as const
type Filter = (typeof FILTERS)[number]

export function ProblemPayouts({
  status,
  token,
  now,
  ask,
}: {
  status: AdminStatus
  token: string
  now: number
  ask: (spec: ConfirmSpec) => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const rows = status.problemPayouts.filter((p) => filter === 'all' || p.status === filter)
  const count = (f: Filter) =>
    f === 'all' ? status.problemPayouts.length : status.problemPayouts.filter((p) => p.status === f).length

  const retry = (p: AdminPayout) =>
    ask({
      title: `Retry payout #${p.id}?`,
      tone: p.status === 'failed_permanent' ? 'danger' : 'ok',
      body: (
        <>
          <p>
            <Pump raw={p.amountRaw} /> → <span className="font-mono text-ink">{p.wallet}</span> ({p.kind},
            round #{p.roundId})
          </p>
          <p>
            Sets the payout back to <b className="text-ink">queued</b> (clears its error and backoff) and
            wakes the worker. A <code>failed</code> payout’s previous attempts provably did not land, so this
            cannot double-pay.
          </p>
          {p.status === 'failed_permanent' && p.kind === 'jackpot' ? (
            <p className="rounded-lg border border-gold/50 bg-gold/10 p-2 text-gold">
              This jackpot was returned to the pot when it failed. Retrying takes the same amount back out of
              the pot first (refused if the pot no longer holds it).
            </p>
          ) : null}
          {p.status === 'failed_permanent' ? (
            <p className="rounded-lg border border-gold/50 bg-gold/10 p-2 text-gold">
              ⚠ This failed with a deterministic error. Unless the cause is fixed it will most likely fail the
              same way, and repeated simulation failures trip the <b>payouts_stuck</b> pause.
            </p>
          ) : null}
          {p.error ? (
            <p className="whitespace-pre-wrap break-words rounded-lg bg-stage/60 p-2 font-mono text-xs text-red-200">
              {p.error}
            </p>
          ) : null}
        </>
      ),
      note: {
        label: 'Why should it succeed now?',
        required: true,
        placeholder: 'e.g. recipient account unfrozen',
      },
      confirmLabel: 'Retry payout',
      success: `Payout #${p.id} re-queued.`,
      run: (note) => adminPost(`/payouts/${encodeURIComponent(p.id)}/retry`, token, { note }),
    })

  return (
    <Card
      id="problem-payouts"
      title="Problem payouts"
      right={
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${
                filter === f
                  ? 'border-gold bg-gold/15 text-gold'
                  : 'border-muted/30 text-muted hover:text-ink'
              }`}
            >
              {f} <span className="tabular-nums">{count(f)}</span>
            </button>
          ))}
        </div>
      }
    >
      {rows.length === 0 ? (
        <Empty>
          {status.problemPayouts.length === 0
            ? 'Nothing held, failed or in flight. 🎉'
            : 'None with this status.'}
        </Empty>
      ) : (
        <ul className="space-y-2">
          {rows.map((p) => (
            <li key={p.id} className="rounded-2xl border border-magenta/15 bg-stage/45 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-display text-ink">#{p.id}</span>
                  <Pill tone={STATUS_TONE[p.status] ?? 'muted'}>{p.status}</Pill>
                  <Pill tone="muted">{p.kind}</Pill>
                  <span className="text-xs text-muted">
                    round #{p.roundId} · {fmtTime(p.createdAt)} {now ? `· ${ago(p.createdAt, now)}` : ''}
                  </span>
                </div>
                {p.status === 'failed' || p.status === 'failed_permanent' ? (
                  <button type="button" className={btnSmall} onClick={() => retry(p)}>
                    ↻ Retry
                  </button>
                ) : null}
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-muted">amount</dt>
                  <dd className="text-sm text-ink">
                    <Pump raw={p.amountRaw} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">to</dt>
                  <dd>
                    <Addr addr={p.wallet} cluster={status.cluster} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">tx</dt>
                  <dd>
                    <Tx sig={p.txSig ?? p.attempt?.lastSignature ?? null} cluster={status.cluster} />
                    {p.attempt ? (
                      <span className="ml-1 text-xs text-muted">
                        (attempt {p.attempt.attempts}: {p.attempt.lastStatus})
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted" title="rebuilt transactions · consecutive failed simulations">
                    rebuilds · sim fails
                  </dt>
                  <dd className="tabular-nums text-ink">
                    {p.rebuilds} ·{' '}
                    <span className={p.simFailures > 0 ? 'text-red-300' : ''}>{p.simFailures}</span>
                  </dd>
                </div>
                {p.heldReason ? (
                  <div>
                    <dt className="text-muted">held reason</dt>
                    <dd className="text-gold">{p.heldReason}</dd>
                  </div>
                ) : null}
                {p.nextAttemptAt ? (
                  <div>
                    <dt className="text-muted">next attempt</dt>
                    <dd className="text-ink">
                      {fmtTime(p.nextAttemptAt)}{' '}
                      <span className="text-muted">{ago(p.nextAttemptAt, now)}</span>
                    </dd>
                  </div>
                ) : null}
                {p.sentAt ? (
                  <div>
                    <dt className="text-muted">sent</dt>
                    <dd className="text-ink">{fmtTime(p.sentAt)}</dd>
                  </div>
                ) : null}
                {p.leaseOwner ? (
                  <div>
                    <dt className="text-muted">lease</dt>
                    <dd
                      className="truncate font-mono text-ink"
                      title={`${p.leaseOwner} until ${p.leaseExpiresAt ?? '?'}`}
                    >
                      {p.leaseOwner}
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt className="text-muted">signer</dt>
                  <dd className="text-ink">{p.signer}</dd>
                </div>
              </dl>
              {p.error ? (
                <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-red-500/10 px-2 py-1.5 font-mono text-xs text-red-200">
                  {p.error}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

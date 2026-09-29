'use client'

import type { ConfirmSpec } from './ConfirmDialog'
import { adminPost } from './client'
import { ago, fmtTime } from './format'
import type { AdminStatus, HardPauseReason } from './types'
import { btnDanger, btnOk, Pill } from './ui'

/** apps/api/src/engine/pauses.ts — the pauses that never clear themselves, in the API's priority order */
const HARD_ORDER: HardPauseReason[] = [
  'manual',
  'breaker_mismatch',
  'invariant',
  'mint_changed',
  'payouts_stuck',
]

const REASONS: Record<HardPauseReason, { label: string; what: string; before: string; ack?: string }> = {
  manual: {
    label: 'Manual',
    what: 'Paused by an operator from this console.',
    before: 'Resume once whatever prompted the pause is resolved.',
  },
  breaker_mismatch: {
    label: 'Breaker mismatch',
    what: 'A revealed prize failed its seed recomputation (Decision E hard stop). That is a bug or tampering, not variance.',
    before: 'Find out why the prize did not re-derive from the round seed before paying anything again.',
    ack: 'I investigated the seed mismatch and paying again is safe.',
  },
  invariant: {
    label: 'Invariant',
    what: 'An unexplained outflow from the PRIZE wallet, or a detected double payment — treat as a possible key compromise.',
    before:
      'Reconcile the PRIZE wallet against the ledger and rotate PRIZE_WALLET_KEY if there is any doubt before resuming.',
    ack: 'I reconciled the PRIZE wallet; the outflow is explained and the key is safe.',
  },
  mint_changed: {
    label: 'Mint changed',
    what: 'The payout mint’s Token-2022 extensions / transfer hook changed (or it had a hook the first time it was seen).',
    before: 'Review the new mint state shown in the note (new fingerprint vs the previously accepted one).',
    ack: 'I reviewed the mint change. Resuming records the payout mint’s CURRENT state as the accepted one.',
  },
  payouts_stuck: {
    label: 'Payouts stuck',
    what: 'A PRIZE payout keeps failing to simulate, so the worker stopped instead of retrying silently forever.',
    before:
      'Look at the failing payout in “Problem payouts” (error, sim failures) and fix the cause — recipient account, mint, RPC — before resuming.',
  },
}

export function StatusBanner({
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
  const pauses = [...status.pauses].sort(
    (a, b) => HARD_ORDER.indexOf(a.reason) - HARD_ORDER.indexOf(b.reason),
  )
  const m = status.monitor
  const neverChecked = m.checkedAt === null
  const autoHolds: string[] = []
  if (neverChecked) autoHolds.push('wallet monitor has not completed a check yet — fail-closed')
  else {
    if (m.lowGas) autoHolds.push('low_gas — PRIZE SOL below MIN_GAS_SOL')
    if (m.lowPool)
      autoHolds.push(
        m.lowPoolReason === 'no_price'
          ? 'low_pool — no PUMP price has ever been known (fail-closed)'
          : 'low_pool — pool P below MIN_POOL_RESERVE (new rounds are skipped)',
      )
  }
  const breakerHeld = status.problemPayouts.filter((p) => p.status === 'held').length
  const hard = pauses.length > 0
  const state = hard ? 'PAUSED' : autoHolds.length > 0 ? 'HELD' : 'RUNNING'
  const manualActive = pauses.some((p) => p.reason === 'manual')

  const frame =
    state === 'PAUSED'
      ? 'border-red-400/70 bg-gradient-to-br from-red-600/35 to-plum/40 shadow-[0_0_60px_-15px_rgba(248,113,113,0.8)]'
      : state === 'HELD'
        ? 'border-gold/60 bg-gradient-to-br from-gold-deep/25 to-plum/40'
        : 'border-emerald-400/50 bg-gradient-to-br from-emerald-500/20 to-plum/40'

  const pause = () =>
    ask({
      title: 'Pause all payouts?',
      tone: 'danger',
      body: (
        <>
          <p>
            Sets the <b className="text-ink">manual</b> hard pause. Every API process stops building new
            payout transfers within ~2 seconds. Rounds keep running, scratches still reveal and wins keep
            queueing — nothing is dropped.
          </p>
          <p>It stays paused (across restarts) until someone resumes “manual” here.</p>
        </>
      ),
      note: {
        label: 'Why are you pausing?',
        required: true,
        placeholder: 'e.g. investigating odd outflow on PRIZE',
      },
      confirmLabel: 'Pause payouts',
      success: 'Payouts paused (manual).',
      run: (note) => adminPost('/pause', token, { reason: 'manual', note }),
    })

  const resume = (reason: HardPauseReason, note: string) => {
    const r = REASONS[reason] ?? { label: reason, what: 'Unrecognized pause reason.', before: '' }
    const others = pauses.filter((p) => p.reason !== reason)
    ask({
      title: `Resume “${reason}”?`,
      tone: reason === 'manual' ? 'ok' : 'danger',
      body: (
        <>
          <p>
            <b className="text-ink">{r.label}:</b> {r.what}
          </p>
          <p className="rounded-lg bg-stage/60 p-2 font-mono text-xs text-ink">{note || '(no note)'}</p>
          <p>{r.before}</p>
          {reason === 'mint_changed' ? (
            <p className="rounded-lg border border-gold/50 bg-gold/10 p-2 text-gold">
              ⚠ Resuming <b>mint_changed</b> acknowledges the new mint state: the API records the payout
              mint’s current extensions / transfer hook as reviewed (config <code>mint.ack</code>) and payouts
              flow through that mint as it is now. This pause will not fire again for this same state — only a
              further change re-pauses.
            </p>
          ) : null}
          {others.length > 0 ? (
            <p className="text-gold">
              Payouts stay paused: {others.map((p) => p.reason).join(', ')} still active.
            </p>
          ) : autoHolds.length > 0 ? (
            <p className="text-gold">
              Payouts stay held until the automatic holds clear: {autoHolds.join('; ')}.
            </p>
          ) : (
            <p>This is the only active pause — payouts restart as soon as it clears.</p>
          )}
        </>
      ),
      acknowledge: r.ack,
      note: { label: 'Resume note (goes into the event log + Telegram)', required: true },
      confirmLabel: `Resume ${reason}`,
      success: `Cleared the “${reason}” pause.`,
      run: (n) => adminPost('/resume', token, { reason, note: n }),
    })
  }

  return (
    <section className={`rounded-3xl border p-4 sm:p-6 ${frame}`} aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.25em] text-muted">Payouts</p>
          <p
            className={`font-display text-5xl leading-none sm:text-6xl ${
              state === 'PAUSED' ? 'text-red-300' : state === 'HELD' ? 'text-gold' : 'text-emerald-300'
            }`}
          >
            {state}
          </p>
          <p className="mt-2 text-sm text-muted">
            {state === 'PAUSED'
              ? 'Hard pause — only an operator can resume.'
              : state === 'HELD'
                ? 'Automatic hold — resumes by itself once balances recover (with hysteresis).'
                : 'Worker is free to send. Wins pay out as they are scratched.'}
          </p>
        </div>
        {!manualActive ? (
          <button type="button" className={btnDanger} onClick={pause}>
            Pause payouts
          </button>
        ) : null}
      </div>

      {pauses.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {pauses.map((p) => (
            <li key={p.reason} className="rounded-2xl border border-red-400/40 bg-stage/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone="bad">{p.reason}</Pill>
                  <span className="text-xs text-muted" title={p.at}>
                    since {fmtTime(p.at)} {now ? `· ${ago(p.at, now)}` : ''}
                  </span>
                </div>
                <button type="button" className={btnOk} onClick={() => resume(p.reason, p.note)}>
                  Resume {p.reason}
                </button>
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-ink">
                {p.note || '(no note)'}
              </p>
              <p className="mt-1 text-xs text-muted">{REASONS[p.reason]?.what}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {autoHolds.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {autoHolds.map((h) => (
            <li key={h} className="flex items-center gap-2 text-sm text-gold">
              <Pill tone="warn">auto</Pill> {h}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {breakerHeld > 0 ? (
          <Pill
            tone="warn"
            title="Per-round breaker holds, released at the round boundary if every prize re-derives"
          >
            {breakerHeld} payout{breakerHeld === 1 ? '' : 's'} breaker-held
          </Pill>
        ) : null}
        {status.oracle.state === 'frozen' || status.oracle.state === 'none' ? (
          <Pill
            tone="bad"
            title="Eligibility frozen at the last known price; payouts are PUMP-denominated and continue"
          >
            prices {status.oracle.state}
          </Pill>
        ) : null}
        {m.creatorGasLow ? <Pill tone="warn">CREATOR gas low (alert only)</Pill> : null}
        {m.lastError ? (
          <Pill tone="bad" title={m.lastError}>
            last monitor check failed
          </Pill>
        ) : null}
      </div>
    </section>
  )
}

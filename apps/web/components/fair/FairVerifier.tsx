'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, ApiError } from '@/lib/api'
import { useLiveEvent } from '@/lib/live'
import { shortWallet } from '@/lib/money'
import { savedWallet } from '@/lib/session'
import { FairInputError, loadNextSample, loadReport, type Loaded, type Query, type Report } from './load'
import { ReportView } from './ReportView'
import { Unrevealed } from './Unrevealed'
import {
  parseRoundInput,
  parseTicketInput,
  pickDefaultRound,
  recentEndedRounds,
  WALLET_RE,
  type RoundHistoryRow,
} from './verify'

type View =
  | { kind: 'idle' }
  | { kind: 'loading'; query: Query }
  | { kind: 'error'; query: Query | null; message: string }
  | Loaded

interface FormErrors {
  round?: string
  wallet?: string
  ticket?: string
}

function validate(
  round: string,
  wallet: string,
  ticket: string,
): { query: Query | null; errors: FormErrors } {
  const errors: FormErrors = {}
  const roundId = parseRoundInput(round)
  if (roundId === null) errors.round = 'Enter a round number, e.g. 42.'
  const w = wallet.trim()
  if (w && !WALLET_RE.test(w)) errors.wallet = 'That doesn’t look like a Solana address.'
  const t = parseTicketInput(ticket)
  if (t === 'invalid') errors.ticket = 'Ticket # is a whole number (0 = first ticket).'
  else if (t !== null && !w) errors.ticket = 'Add the wallet to check a single ticket.'
  if (Object.keys(errors).length > 0 || roundId === null || t === 'invalid') return { query: null, errors }
  return { query: { roundId, wallet: w || null, ticketIdx: t }, errors }
}

function describeError(e: unknown, q: Query): string {
  if (e instanceof FairInputError) return e.message
  if (e instanceof ApiError) {
    if (e.status === 404) return `There's no round #${q.roundId} (yet).`
    if (e.status === 409)
      return `Round #${q.roundId} hasn't been revealed yet — outcomes are published when it ends.`
    if (e.status === 429) return 'Too many requests — give it a few seconds and try again.'
    return e.message
  }
  return 'Could not reach the server — check your connection and try again.'
}

/** Keep the address bar shareable: /fair?round=12&wallet=…&ticket=3 */
function syncUrl(q: Query) {
  const p = new URLSearchParams({ round: String(q.roundId) })
  if (q.wallet) p.set('wallet', q.wallet)
  if (q.ticketIdx !== null) p.set('ticket', String(q.ticketIdx))
  window.history.replaceState(null, '', `/fair?${p.toString()}`)
}

const noopSubscribe = () => () => {}

const inputCls =
  'w-full rounded-xl border bg-stage/80 px-4 py-3 text-ink outline-none placeholder:text-muted/50 focus:border-gold'

export function FairVerifier({
  initialRound,
  initialWallet,
  initialTicket,
}: {
  initialRound: string
  initialWallet: string
  initialTicket: string
}) {
  const [round, setRound] = useState(initialRound)
  const [wallet, setWallet] = useState(initialWallet)
  const [ticket, setTicket] = useState(initialTicket)
  const [errors, setErrors] = useState<FormErrors>({})
  const [recent, setRecent] = useState<RoundHistoryRow[]>([])
  // a deep link (?round=…) verifies straight away; otherwise wait for the button
  const [view, setView] = useState<View>(() => {
    const { query } = validate(initialRound, initialWallet, initialTicket)
    return query ? { kind: 'loading', query } : { kind: 'idle' }
  })
  const [moreBusy, setMoreBusy] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const reqRef = useRef(0)
  const mine = useSyncExternalStore(noopSubscribe, savedWallet, () => null)

  /** fetch + verify; only ever sets state asynchronously, and drops stale responses */
  const execute = useCallback((q: Query) => {
    const id = ++reqRef.current
    loadReport(q).then(
      (loaded) => {
        if (id === reqRef.current) setView(loaded)
      },
      (e: unknown) => {
        if (id === reqRef.current) setView({ kind: 'error', query: q, message: describeError(e, q) })
      },
    )
  }, [])

  const start = (q: Query) => {
    setView({ kind: 'loading', query: q })
    setMoreError(null)
    syncUrl(q)
    execute(q)
  }

  // on mount: deep-link verification, plus recent rounds for the quick picks / default round
  useEffect(() => {
    const { query } = validate(initialRound, initialWallet, initialTicket)
    if (query) execute(query)
    Promise.allSettled([api.stats(), api.round()]).then(([stats, current]) => {
      const history = stats.status === 'fulfilled' ? stats.value.poolHistory : null
      if (history) setRecent(recentEndedRounds(history))
      const def = pickDefaultRound(history, current.status === 'fulfilled' ? current.value.round : null)
      if (def !== null) setRound((r) => (r.trim() === '' ? String(def) : r))
    })
  }, [execute, initialRound, initialWallet, initialTicket])

  // the seed of a round we're waiting on just got revealed → verify it right away
  useLiveEvent((e) => {
    if (e.type === 'round_end' && view.kind === 'unrevealed' && e.roundId === view.query.roundId) {
      setView({ kind: 'loading', query: view.query })
      execute(view.query)
    }
  })

  const submit = (r = round, w = wallet, t = ticket) => {
    const v = validate(r, w, t)
    setErrors(v.errors)
    if (v.query) start(v.query)
  }

  const loadMore = (report: Report) => {
    setMoreBusy(true)
    setMoreError(null)
    const id = reqRef.current
    loadNextSample(report).then(
      (next) => {
        if (id !== reqRef.current) return
        setView({ kind: 'report', report: next })
        setMoreBusy(false)
      },
      (e: unknown) => {
        if (id !== reqRef.current) return
        setMoreError(describeError(e, report.query))
        setMoreBusy(false)
      },
    )
  }

  const busy = view.kind === 'loading'
  const walletTrim = wallet.trim()

  return (
    <div className="flex flex-col gap-4">
      <form
        id="verify"
        className="panel flex scroll-mt-20 flex-col gap-3 p-4 sm:p-6"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        noValidate
      >
        <div>
          <h2 className="font-display text-2xl">Verify a round</h2>
          <p className="text-sm text-muted">
            Everything below is recomputed in your browser from the revealed seed — the server only supplies
            the data.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[9rem_1fr_9rem]">
          <label className="flex flex-col gap-1 sm:order-1">
            <span className="text-xs uppercase tracking-[0.2em] text-muted">Round #</span>
            <input
              className={`${inputCls} font-display text-lg ${errors.round ? 'border-red-400' : 'border-magenta/40'}`}
              value={round}
              onChange={(e) => setRound(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="e.g. 42"
              aria-invalid={!!errors.round}
              aria-describedby={errors.round ? 'round-err' : undefined}
            />
          </label>
          <label className="flex flex-col gap-1 sm:order-3">
            <span className="text-xs uppercase tracking-[0.2em] text-muted">
              Ticket # <span className="normal-case tracking-normal text-muted/70">(optional)</span>
            </span>
            <input
              className={`${inputCls} font-display text-lg ${errors.ticket ? 'border-red-400' : 'border-magenta/25'}`}
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="all"
              aria-invalid={!!errors.ticket}
              aria-describedby={errors.ticket ? 'ticket-err' : undefined}
            />
          </label>
          <label className="col-span-2 flex flex-col gap-1 sm:order-2 sm:col-span-1">
            <span className="flex items-center justify-between gap-2 text-xs uppercase tracking-[0.2em] text-muted">
              <span>
                Wallet <span className="normal-case tracking-normal text-muted/70">(optional)</span>
              </span>
              {mine && mine !== walletTrim && (
                <button
                  type="button"
                  className="rounded-full px-2 py-0.5 text-[11px] normal-case tracking-normal text-gold hover:bg-stage-3"
                  onClick={() => setWallet(mine)}
                >
                  use mine · {shortWallet(mine)}
                </button>
              )}
            </span>
            <input
              className={`${inputCls} font-mono text-sm ${errors.wallet ? 'border-red-400' : 'border-magenta/25'}`}
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="empty = spot-check the whole round"
              aria-invalid={!!errors.wallet}
              aria-describedby={errors.wallet ? 'wallet-err' : undefined}
            />
          </label>
        </div>
        {(errors.round || errors.wallet || errors.ticket) && (
          <ul className="text-sm text-red-300" role="alert">
            {errors.round && <li id="round-err">{errors.round}</li>}
            {errors.wallet && <li id="wallet-err">{errors.wallet}</li>}
            {errors.ticket && <li id="ticket-err">{errors.ticket}</li>}
          </ul>
        )}

        <button type="submit" className="btn-gold w-full text-lg sm:w-auto sm:self-start" disabled={busy}>
          {busy ? 'VERIFYING…' : 'VERIFY IN MY BROWSER'}
        </button>

        {recent.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="mr-1 text-xs uppercase tracking-[0.2em] text-muted">Recent</span>
            {recent.map((r) => (
              <button
                key={r.id}
                type="button"
                disabled={busy}
                onClick={() => {
                  setRound(String(r.id))
                  submit(String(r.id))
                }}
                className="btn-ghost !px-3 !py-1 text-xs tabular-nums hover:border-gold/60 hover:text-gold disabled:opacity-50"
              >
                #{r.id}
                <span className="text-muted"> · {r.tickets.toLocaleString('en-US')} tix</span>
              </button>
            ))}
          </div>
        )}
      </form>

      <div aria-live="polite" className="flex flex-col gap-4">
        {view.kind === 'loading' && <LoadingPanel query={view.query} />}
        {view.kind === 'error' && (
          <div className="panel flex flex-col gap-3 border-red-400/50 p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-red-200">
              <span aria-hidden>⚠️ </span>
              {view.message}
            </p>
            {view.query && (
              <button type="button" className="btn-ghost shrink-0" onClick={() => start(view.query!)}>
                Try again
              </button>
            )}
          </div>
        )}
        {view.kind === 'unrevealed' && (
          <Unrevealed
            round={view.round}
            onCheckAgain={() => {
              setView({ kind: 'loading', query: view.query })
              execute(view.query)
            }}
          />
        )}
        {view.kind === 'report' && (
          <ReportView
            key={`${view.report.query.roundId}:${view.report.query.wallet}:${view.report.query.ticketIdx}`}
            report={view.report}
            onLoadMore={() => loadMore(view.report)}
            moreBusy={moreBusy}
            moreError={moreError}
          />
        )}
      </div>
    </div>
  )
}

function LoadingPanel({ query }: { query: Query }) {
  return (
    <div className="panel flex items-center gap-3 p-4" role="status">
      <span
        aria-hidden
        className="size-5 shrink-0 animate-spin rounded-full border-2 border-gold border-t-transparent"
      />
      <p className="text-muted">
        Fetching round <span className="font-display text-ink">#{query.roundId}</span>
        {query.wallet ? ` for ${shortWallet(query.wallet)}` : ''} and recomputing its tickets…
      </p>
    </div>
  )
}

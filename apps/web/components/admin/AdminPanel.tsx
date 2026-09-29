'use client'

import { useCallback, useRef, useState } from 'react'
import { API_ORIGIN } from '@/lib/config'
import { ConfirmDialog, type ConfirmSpec } from './ConfirmDialog'
import { setAdminToken, useAdminStatus, useAdminToken, useNow } from './client'
import { ClearHandleTool, PayoutRateControl } from './Controls'
import { MonitorCard, OracleCard, QueueCard } from './Health'
import { RecentEvents, RecentRounds, RecentSweeps } from './History'
import { ProblemPayouts } from './ProblemPayouts'
import { StatusBanner } from './StatusBanner'
import { TokenGate } from './TokenGate'
import { Addr, btnSmall, ErrorText, Pill } from './ui'

/** Operator console (PLAN §3.2 admin + §5 ops): token gate → auto-refreshing dashboard. */
export function AdminPanel() {
  const { token, hydrated } = useAdminToken()
  if (!hydrated) return <p className="pt-16 text-center text-sm text-muted">Loading operator console…</p>
  if (!token) return <TokenGate />
  // keyed by token: forgetting / replacing it drops every bit of dashboard state
  return <Dashboard key={token} token={token} />
}

const REFRESH_MS = 5_000

function Dashboard({ token }: { token: string }) {
  const { status, error, okAt, loading, visible, refresh } = useAdminStatus(token, REFRESH_MS)
  const now = useNow(1_000)
  const [confirm, setConfirm] = useState<{ spec: ConfirmSpec; key: number } | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)

  const ask = useCallback((spec: ConfirmSpec) => {
    seq.current += 1
    setConfirm({ spec, key: seq.current })
  }, [])

  const close = useCallback(() => setConfirm(null), [])

  const done = (message: string) => {
    setConfirm(null)
    setFlash(message)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 8_000)
    refresh()
  }

  const forget = () => setAdminToken(null)
  const updated = okAt && now ? Math.max(0, Math.round((now - okAt) / 1000)) : null

  return (
    <div className="flex flex-col gap-4 pt-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.25em] text-muted">$SCRATCHY · admin</p>
          <h1 className="font-display text-3xl text-ink sm:text-4xl">Operator console</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            {status ? (
              <Pill tone={status.cluster === 'mainnet-beta' ? 'warn' : 'info'}>{status.cluster}</Pill>
            ) : null}
            <span className="break-all font-mono">{API_ORIGIN}</span>
            <span>·</span>
            {visible ? (
              <span>
                auto-refresh {REFRESH_MS / 1000}s{updated !== null ? ` · updated ${updated}s ago` : ''}
                {loading ? ' · …' : ''}
              </span>
            ) : (
              <span className="text-gold">auto-refresh paused (tab hidden)</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnSmall} onClick={refresh} disabled={loading}>
            ↻ Refresh
          </button>
          <button type="button" className={btnSmall} onClick={forget}>
            Forget token
          </button>
        </div>
      </header>

      {status ? (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
          <span>
            PRIZE <Addr addr={status.wallets.prize} cluster={status.cluster} />
          </span>
          <span>
            CREATOR <Addr addr={status.wallets.creator} cluster={status.cluster} />
          </span>
          <span>
            OPS <Addr addr={status.wallets.ops} cluster={status.cluster} />
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="space-y-2">
          <ErrorText>
            {status && okAt
              ? `Refresh failing — showing data from ${new Date(okAt).toLocaleTimeString()}.\n`
              : 'Could not load /api/admin/status.\n'}
            {error.text}
          </ErrorText>
          {error.httpStatus === 401 ? (
            <p className="text-sm text-gold">
              The API rejected this token.{' '}
              <button type="button" className="underline" onClick={forget}>
                Forget it
              </button>{' '}
              and paste the current ADMIN_TOKEN.
            </p>
          ) : null}
        </div>
      ) : null}

      {flash ? (
        <p
          role="status"
          className="rounded-xl border border-emerald-400/50 bg-emerald-500/15 px-3 py-2 text-sm text-emerald-200"
        >
          ✓ {flash}
        </p>
      ) : null}

      {!status ? (
        !error ? (
          <p className="panel p-6 text-center text-sm text-muted">Loading status…</p>
        ) : null
      ) : (
        <>
          <StatusBanner status={status} token={token} now={now} ask={ask} />
          <div className="grid gap-4 lg:grid-cols-3">
            <MonitorCard status={status} now={now} />
            <OracleCard status={status} now={now} />
            <QueueCard status={status} />
          </div>
          <ProblemPayouts status={status} token={token} now={now} ask={ask} />
          <div className="grid gap-4 lg:grid-cols-2">
            <PayoutRateControl status={status} token={token} ask={ask} />
            <ClearHandleTool token={token} ask={ask} />
          </div>
          <RecentRounds status={status} />
          <RecentSweeps status={status} />
          <RecentEvents status={status} now={now} />
        </>
      )}

      {confirm ? <ConfirmDialog key={confirm.key} spec={confirm.spec} onClose={close} onDone={done} /> : null}
    </div>
  )
}

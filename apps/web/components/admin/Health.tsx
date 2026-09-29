'use client'

import { ago, exactScaled, fmtPriceE18, fmtSol, fmtTime } from './format'
import type { AdminStatus, PriceQuote, PriceState } from './types'
import { Card, KV, Pill, Pump } from './ui'

/** PRIZE wallet monitor (low_gas / low_pool), price oracle, and payout queue counts. */

function ratioX(p: bigint, reserve: bigint): string {
  if (reserve <= 0n) return '—'
  const tenths = (p * 10n) / reserve
  return `${tenths / 10n}.${tenths % 10n}×`
}

export function MonitorCard({ status, now }: { status: AdminStatus; now: number }) {
  const m = status.monitor
  const pool = m.poolRaw === null ? null : BigInt(m.poolRaw)
  const reserve = m.reserveRaw === null ? null : BigInt(m.reserveRaw)
  const headroom = pool !== null && reserve !== null ? pool - reserve : null
  return (
    <Card
      title="PRIZE wallet"
      right={
        <>
          {m.lowGas ? <Pill tone="bad">low_gas</Pill> : <Pill tone="ok">gas ok</Pill>}
          {m.lowPool ? (
            <Pill tone="bad">low_pool{m.lowPoolReason ? ` · ${m.lowPoolReason}` : ''}</Pill>
          ) : (
            <Pill tone="ok">pool ok</Pill>
          )}
        </>
      }
    >
      <div className="mb-3 rounded-2xl bg-stage/50 p-3">
        <p className="text-[11px] uppercase tracking-[0.2em] text-muted">PUMP balance (ATA, finalized)</p>
        <p className="font-display text-3xl text-ink">
          <Pump raw={m.prizePumpRaw} />
        </p>
        {m.prizePumpRaw !== null ? (
          <p className="break-all font-mono text-[11px] text-muted">
            raw {m.prizePumpRaw} = {exactScaled(m.prizePumpRaw, 6)}
          </p>
        ) : null}
      </div>
      <dl>
        <KV k="Jackpot pot J">
          <Pump raw={m.jackpotRaw} />
        </KV>
        <KV k="Outstanding (owed, not landed)">
          <Pump raw={m.outstandingRaw} />
        </KV>
        <KV k="Pool P = PUMP − J − owed">
          <Pump raw={m.poolRaw} />
        </KV>
        <KV
          k="Reserve floor"
          hint={
            reserve === null ? 'no PUMP price ever known — fail-closed' : 'MIN_POOL_RESERVE_USD at last price'
          }
        >
          <Pump raw={m.reserveRaw} />
        </KV>
        <KV
          k="Headroom P − reserve"
          hint={pool !== null && reserve !== null ? `P is ${ratioX(pool, reserve)} the floor` : undefined}
        >
          {headroom === null ? (
            <span className="text-muted">—</span>
          ) : (
            <span className={headroom < 0n ? 'text-red-300' : 'text-emerald-300'}>
              {headroom < 0n ? '−' : ''}
              <Pump raw={(headroom < 0n ? -headroom : headroom).toString()} />
            </span>
          )}
        </KV>
        <KV
          k="PRIZE SOL (gas)"
          hint={
            status.thresholds
              ? `pauses below ${status.thresholds.minGasSol} SOL · resumes at ×${(1 + Number(status.thresholds.reserveHysteresis)).toFixed(2)}`
              : undefined
          }
        >
          <span className={m.lowGas ? 'text-red-300' : ''}>{fmtSol(m.prizeSolLamports)} SOL</span>
        </KV>
        <KV k="CREATOR SOL" hint={m.creatorGasLow ? 'below its floor — alert only' : undefined}>
          <span className={m.creatorGasLow ? 'text-gold' : ''}>{fmtSol(m.creatorSolLamports)} SOL</span>
        </KV>
        <KV
          k="Last check"
          hint={m.checkedAt ? ago(m.checkedAt, now) : 'never — fail-closed until the first check'}
        >
          {fmtTime(m.checkedAt)}
        </KV>
      </dl>
      {m.lastError ? (
        <p className="mt-2 whitespace-pre-wrap break-words rounded-xl border border-red-400/50 bg-red-500/15 px-3 py-2 font-mono text-xs text-red-200">
          last check failed: {m.lastError}
        </p>
      ) : null}
    </Card>
  )
}

const PRICE_TONE: Record<PriceState, 'ok' | 'warn' | 'bad'> = {
  fresh: 'ok',
  stale: 'warn',
  frozen: 'bad',
  none: 'bad',
}
const PRICE_HELP: Record<PriceState, string> = {
  fresh: 'All prices from live sources within PRICE_CACHE_SECONDS.',
  stale: 'A source failed — serving the cached value (still within tolerance).',
  frozen:
    'All sources failing — eligibility frozen at the last known price. Payouts continue (PUMP-denominated).',
  none: 'No price has ever been known — the reserve check fails closed.',
}

function Quote({
  q,
  prefix,
  suffix,
  now,
}: {
  q: PriceQuote | null
  prefix?: string
  suffix?: string
  now: number
}) {
  if (!q) return <span className="text-muted">none</span>
  return (
    <span title={`${q.valueE18} (×1e18) · ${q.source} · ${q.at}`}>
      {prefix}
      {fmtPriceE18(q.valueE18)}
      {suffix}
      <span className="block text-[11px] text-muted">
        {q.source} · {fmtTime(q.at)} {now ? `· ${ago(q.at, now)}` : ''}
      </span>
    </span>
  )
}

export function OracleCard({ status, now }: { status: AdminStatus; now: number }) {
  const o = status.oracle
  return (
    <Card title="Price oracle" right={<Pill tone={PRICE_TONE[o.state]}>{o.state}</Pill>}>
      <p className="mb-2 text-xs text-muted">{PRICE_HELP[o.state]}</p>
      <dl>
        <KV k="PUMP / USD">
          <Quote q={o.pumpUsd} prefix="$" now={now} />
        </KV>
        <KV k="SCRATCHY / PUMP">
          <Quote q={o.scratchyPump} suffix=" PUMP" now={now} />
        </KV>
        <KV k="SCRATCHY / USD">
          <Quote q={o.scratchyUsd} prefix="$" now={now} />
        </KV>
        <KV k="Last fully fresh" hint={o.lastFreshAt ? ago(o.lastFreshAt, now) : undefined}>
          {fmtTime(o.lastFreshAt)}
        </KV>
      </dl>
    </Card>
  )
}

export function QueueCard({ status }: { status: AdminStatus }) {
  const q = status.queue ?? { queued: 0, sending: 0 }
  const counts = { held: 0, failed: 0, failed_permanent: 0 }
  for (const p of status.problemPayouts) {
    if (p.status === 'held' || p.status === 'failed' || p.status === 'failed_permanent') counts[p.status]++
  }
  const capped = status.problemPayouts.length >= 100
  const cell = (label: string, n: number, tone: 'ok' | 'warn' | 'bad', hint: string) => (
    <div className="rounded-2xl bg-stage/50 p-3" title={hint}>
      <p className="break-all text-[11px] uppercase tracking-[0.12em] text-muted">{label}</p>
      <p
        className={`font-display text-3xl tabular-nums ${
          n === 0
            ? 'text-ink'
            : tone === 'bad'
              ? 'text-red-300'
              : tone === 'warn'
                ? 'text-gold'
                : 'text-emerald-300'
        }`}
      >
        {n}
        {capped && label !== 'queued' && label !== 'sending' ? '+' : ''}
      </p>
    </div>
  )
  return (
    <Card title="Payout queue">
      <div className="grid grid-cols-2 gap-2">
        {cell('queued', q.queued, 'ok', 'won, not yet attempted (or waiting out a pause)')}
        {cell('sending', q.sending, 'warn', 'attempt in flight — outcome not yet proven')}
        {cell('held', counts.held, 'warn', 'breaker hold for the round (Decision E)')}
        {cell('failed', counts.failed, 'bad', 'provably did not land — auto-retry queue')}
        {cell('failed_permanent', counts.failed_permanent, 'bad', 'deterministic error — needs an operator')}
      </div>
      {capped ? (
        <p className="mt-2 text-xs text-gold">Problem list is capped at the newest 100 rows.</p>
      ) : null}
    </Card>
  )
}

'use client'

import type { ReactNode } from 'react'
import { fmtPump, shortWallet } from '@/lib/money'
import { accountHref, exactScaled, txHref } from './format'

/** Small shared building blocks for the operator console (site theme: panel / font-display / gold). */

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted'

const PILL: Record<Tone, string> = {
  ok: 'border-emerald-400/50 bg-emerald-400/15 text-emerald-300',
  warn: 'border-gold/50 bg-gold/15 text-gold',
  bad: 'border-red-400/60 bg-red-500/20 text-red-300',
  info: 'border-violet/50 bg-violet/20 text-muted',
  muted: 'border-muted/25 bg-stage/40 text-muted',
}

export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${PILL[tone]}`}
    >
      {children}
    </span>
  )
}

export function Card({
  title,
  right,
  children,
  className = '',
  id,
}: {
  title: ReactNode
  right?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section id={id} className={`panel min-w-0 p-4 sm:p-5 ${className}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg text-ink sm:text-xl">{title}</h2>
        {right ? <div className="flex flex-wrap items-center gap-2 text-xs text-muted">{right}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function KV({ k, children, hint }: { k: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-magenta/10 py-1.5 text-sm last:border-b-0">
      <dt className="shrink-0 text-muted">{k}</dt>
      <dd className="min-w-0 text-right">
        <span className="tabular-nums text-ink">{children}</span>
        {hint ? <span className="block text-[11px] text-muted">{hint}</span> : null}
      </dd>
    </div>
  )
}

/** formatted PUMP amount; hover shows the exact decimal and the raw base units */
export function Pump({
  raw,
  unit = true,
  className = '',
}: {
  raw: string | null
  unit?: boolean
  className?: string
}) {
  if (raw === null) return <span className="text-muted">—</span>
  return (
    <span className={`tabular-nums ${className}`} title={`${exactScaled(raw, 6)} PUMP · raw ${raw}`}>
      {fmtPump(raw)}
      {unit ? <span className="ml-1 text-[0.8em] text-gold">PUMP</span> : null}
    </span>
  )
}

export function Addr({ addr, cluster }: { addr: string | null; cluster: string }) {
  if (!addr) return <span className="text-muted">—</span>
  const href = accountHref(addr, cluster)
  const label = <span className="font-mono">{shortWallet(addr)}</span>
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={addr}
      className="text-gold hover:underline"
    >
      {label}
    </a>
  ) : (
    <span title={addr}>{label}</span>
  )
}

export function Tx({ sig, cluster }: { sig: string | null; cluster: string }) {
  if (!sig) return <span className="text-muted">—</span>
  const href = txHref(sig, cluster)
  const label = (
    <span className="font-mono">{sig.length > 14 ? `${sig.slice(0, 6)}…${sig.slice(-6)}` : sig}</span>
  )
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={sig}
      className="text-gold hover:underline"
    >
      {label} ↗
    </a>
  ) : (
    <span title={`${sig} (in-memory chain — no explorer)`}>{label}</span>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-sm text-muted">{children}</p>
}

/** API errors are shown verbatim */
export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="whitespace-pre-wrap break-words rounded-xl border border-red-400/50 bg-red-500/15 px-3 py-2 font-mono text-xs text-red-200"
    >
      {children}
    </p>
  )
}

export const btnSmall =
  'inline-flex items-center justify-center rounded-full border border-muted/40 bg-stage/60 px-3 py-1.5 text-xs font-bold text-ink transition hover:border-gold/60 hover:text-gold disabled:cursor-not-allowed disabled:opacity-50'
export const btnDanger =
  'inline-flex items-center justify-center rounded-full bg-gradient-to-b from-red-500 to-red-700 px-4 py-2 font-display text-sm tracking-wide text-white shadow-[0_3px_0_#7f1d1d] transition hover:brightness-110 active:translate-y-[2px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-50'
export const btnOk =
  'inline-flex items-center justify-center rounded-full bg-gradient-to-b from-emerald-400 to-emerald-600 px-4 py-2 font-display text-sm tracking-wide text-stage shadow-[0_3px_0_#065f46] transition hover:brightness-110 active:translate-y-[2px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-50'
export const inputCls =
  'w-full rounded-xl border border-muted/30 bg-stage/70 px-3 py-2 text-sm text-ink placeholder:text-muted/60 focus:border-gold/70 focus:outline-none'
export const thCls =
  'whitespace-nowrap px-2 py-1.5 text-left text-[11px] font-bold uppercase tracking-wider text-muted'
export const tdCls = 'whitespace-nowrap px-2 py-1.5 align-top tabular-nums'

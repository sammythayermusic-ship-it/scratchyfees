'use client'

import { useEffect, useState } from 'react'

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    return
  } catch {
    // insecure context (e.g. a phone hitting a LAN dev box) — fall back to a hidden textarea
  }
  const ta = document.createElement('textarea')
  ta.value = value
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new Error('copy failed')
}

/** Small copy-to-clipboard pill. `label` is what a screen reader hears ("Copy seed hash"). */
export function CopyButton({
  value,
  label,
  text = 'copy',
  className = '',
}: {
  value: string
  label: string
  text?: string
  className?: string
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), 1500)
    return () => clearTimeout(t)
  }, [state])
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        copyText(value).then(
          () => setState('copied'),
          () => setState('failed'),
        )
      }}
      className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider transition ${
        state === 'copied'
          ? 'border-emerald-400/60 bg-emerald-400/10 text-emerald-300'
          : state === 'failed'
            ? 'border-red-400/60 text-red-300'
            : 'border-muted/35 bg-stage/60 text-muted hover:border-gold/60 hover:text-gold'
      } ${className}`}
    >
      <span aria-live="polite">
        {state === 'copied' ? 'copied ✓' : state === 'failed' ? 'select & copy' : text}
      </span>
    </button>
  )
}

'use client'

import { useState } from 'react'
import type { ConfirmSpec } from './ConfirmDialog'
import { adminPost } from './client'
import { exactScaled, looksLikeAddress, ppmToPercent, rateToPercent, rateToPpm } from './format'
import type { AdminStatus } from './types'
import { btnSmall, Card, inputCls } from './ui'

/** PAYOUT_RATE knob (applies from the next round) and the clear-X-handle moderation tool. */

export function PayoutRateControl({
  status,
  token,
  ask,
}: {
  status: AdminStatus
  token: string
  ask: (spec: ConfirmSpec) => void
}) {
  const r = status.payoutRate
  const [value, setValue] = useState('')
  const minPpm = rateToPpm(r.min)
  const maxPpm = rateToPpm(r.max)
  const effPpm = rateToPpm(r.effective)
  const ppm = value.trim() ? rateToPpm(value) : null
  const live = status.rounds.find((x) => x.status === 'live')

  let problem: string | null = null
  if (value.trim()) {
    if (ppm === null) problem = 'Enter a decimal with at most 6 places, e.g. 0.005 (= 0.5%).'
    else if (minPpm !== null && maxPpm !== null && (ppm < minPpm || ppm > maxPpm))
      problem = `Must be within ${r.min}–${r.max} (${rateToPercent(r.min)}–${rateToPercent(r.max)}).`
    else if (ppm === effPpm) problem = 'That is already the effective rate.'
  }
  const canApply = ppm !== null && problem === null

  // one-tap presets every 0.1% inside the allowed range
  const presets: bigint[] = []
  if (minPpm !== null && maxPpm !== null) {
    for (let p = minPpm; p <= maxPpm && presets.length < 12; p += 1_000n) presets.push(p)
  }

  const apply = () => {
    if (!canApply || ppm === null) return
    const rate = value.trim()
    ask({
      title: 'Change PAYOUT_RATE?',
      tone: 'ok',
      body: (
        <>
          <p>
            <b className="text-ink">
              {r.effective} ({rateToPercent(r.effective)})
            </b>{' '}
            →{' '}
            <b className="text-gold">
              {rate} ({ppmToPercent(ppm)})
            </b>{' '}
            of the pool per round.
          </p>
          <p>
            Applies from the <b className="text-ink">next round</b>; the live round keeps the rate it
            snapshotted. Every round stores its own parameters, so past rounds still verify. Posts a Telegram
            alert.
          </p>
        </>
      ),
      confirmLabel: `Set ${ppmToPercent(ppm)}`,
      success: `PAYOUT_RATE set to ${rate} — applies from the next round.`,
      run: async () => {
        await adminPost('/payout-rate', token, { rate })
        setValue('')
      },
    })
  }

  return (
    <Card title="PAYOUT_RATE" right={<span>applies from {r.appliesFrom}</span>}>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-muted">effective</p>
          <p className="font-display text-4xl text-gold">{rateToPercent(r.effective)}</p>
          <p className="font-mono text-xs text-muted">{r.effective}</p>
        </div>
        <div className="space-y-0.5 text-sm text-muted">
          <p>
            default <span className="text-ink">{r.default}</span> ({rateToPercent(r.default)})
            {r.effective !== r.default ? <span className="ml-1 text-gold">· overridden</span> : null}
          </p>
          <p>
            allowed <span className="text-ink">{r.min}</span>–<span className="text-ink">{r.max}</span> (
            {rateToPercent(r.min)}–{rateToPercent(r.max)})
          </p>
          {live?.payoutRatePpm ? (
            <p>
              live round #{live.id} uses <span className="text-ink">{ppmToPercent(live.payoutRatePpm)}</span>
            </p>
          ) : null}
        </div>
      </div>

      <form
        className="mt-4 space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          apply()
        }}
      >
        <div className="flex gap-2">
          <input
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`new rate, e.g. ${r.effective}`}
            aria-label="New PAYOUT_RATE"
            className={`${inputCls} font-mono`}
          />
          <button
            type="submit"
            className="btn-pink shrink-0 px-4! py-2! text-sm disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canApply}
          >
            Apply
          </button>
        </div>
        {problem ? <p className="text-xs text-gold">{problem}</p> : null}
        {ppm !== null && !problem ? (
          <p className="text-xs text-muted">
            = {ppmToPercent(ppm)} of the pool per round · applies from the next round
          </p>
        ) : null}
        {presets.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {presets.map((p) => {
              const dec = exactScaled(p, 6)
              return (
                <button
                  key={p.toString()}
                  type="button"
                  onClick={() => setValue(dec)}
                  className={`${btnSmall} ${p === effPpm ? 'border-gold/70! text-gold!' : ''}`}
                  title={dec}
                >
                  {ppmToPercent(p)}
                </button>
              )
            })}
          </div>
        ) : null}
      </form>
    </Card>
  )
}

export function ClearHandleTool({ token, ask }: { token: string; ask: (spec: ConfirmSpec) => void }) {
  const [addr, setAddr] = useState('')
  const a = addr.trim()
  const valid = looksLikeAddress(a)

  const clear = () => {
    if (!valid) return
    ask({
      title: 'Clear this wallet’s X handle?',
      tone: 'danger',
      body: (
        <>
          <p className="break-all font-mono text-ink">{a}</p>
          <p>
            Removes the X handle shown next to this wallet on the winners feed and win flexes. The wallet can
            set a handle again on its next paste.
          </p>
          <p className="text-xs">Recorded in the event log with your note.</p>
        </>
      ),
      confirmLabel: 'Clear handle',
      success: `Cleared the X handle for ${a.slice(0, 4)}…${a.slice(-4)}.`,
      note: { label: 'Reason', required: false, placeholder: 'e.g. impersonation report' },
      run: async (note) => {
        await adminPost(`/wallets/${encodeURIComponent(a)}/clear-handle`, token, note ? { note } : {})
        setAddr('')
      },
    })
  }

  return (
    <Card title="Clear X handle">
      <p className="mb-3 text-sm text-muted">
        Moderation: strip an abusive or impersonating handle from a wallet.
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          clear()
        }}
      >
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="wallet address"
          aria-label="Wallet address"
          autoComplete="off"
          spellCheck={false}
          className={`${inputCls} font-mono`}
        />
        <button type="submit" className={`${btnSmall} shrink-0`} disabled={!valid}>
          Clear
        </button>
      </form>
      {a && !valid ? (
        <p className="mt-1 text-xs text-gold">That doesn’t look like a Solana address.</p>
      ) : null}
    </Card>
  )
}

'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef } from 'react'
import { DOMAIN, X_HANDLE } from '@/lib/config'
import { fmtPump, fmtUsd, solscanTx, TIER_MULTIPLE, TIER_NAMES } from '@/lib/money'
import type { TicketOutcome } from '@/lib/types'
import { usePayoutStatus } from './usePayoutStatus'

/**
 * "🎫 YOU WIN 12,500 PUMP (~$42)" mega-modal with the live tx confirmation and FLEX ON X (PLAN §6).
 * Shows one win, or the summary of a SCRATCH ALL batch (total + per-tier breakdown + the coalesced tx).
 */
export interface WinSummary {
  outcomes: TicketOutcome[]
  pumpUsdE18: string | null
}

export function flexUrl(bestTier: number, jackpot: boolean): string {
  const text = jackpot
    ? `just hit the JACKPOT on @${X_HANDLE} and it paid instantly 💸🎫 $SCRATCHY`
    : `just scratched a ${TIER_MULTIPLE[bestTier] ?? '1.5'}× on @${X_HANDLE} and it paid instantly 💸🎫 $SCRATCHY`
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(`https://${DOMAIN}`)}`
}

export function WinModal({ summary, onClose }: { summary: WinSummary | null; onClose: () => void }) {
  useEffect(() => {
    if (!summary) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [summary, onClose])

  return (
    <AnimatePresence>
      {summary && <WinModalBody key="win" summary={summary} onClose={onClose} />}
    </AnimatePresence>
  )
}

function WinModalBody({ summary, onClose }: { summary: WinSummary; onClose: () => void }) {
  const wins = summary.outcomes.filter((o) => o.tier > 0 || BigInt(o.jackpotPrizeRaw) > 0n)
  const total = wins.reduce((s, o) => s + BigInt(o.prizeRaw) + BigInt(o.jackpotPrizeRaw), 0n)
  const best = wins.reduce((m, o) => Math.max(m, o.tier), 0)
  const jackpot = wins.some((o) => BigInt(o.jackpotPrizeRaw) > 0n)
  const payoutId =
    wins.find((o) => o.payoutId)?.payoutId ?? wins.find((o) => o.jackpotPayoutId)?.jackpotPayoutId ?? null
  const held = wins.some((o) => o.held)
  const { status, txSig } = usePayoutStatus(payoutId)
  const byTier = [1, 2, 3, 4, 5]
    .map((t) => ({ t, n: wins.filter((o) => o.tier === t).length }))
    .filter((x) => x.n > 0)
  // the modal pops up mid-gesture: ignore taps for a moment so a scratching finger can't hit FLEX / close by accident
  const armed = useRef(false)
  useEffect(() => {
    const t = setTimeout(() => (armed.current = true), 600)
    return () => clearTimeout(t)
  }, [])

  return (
    <motion.div
      className="fixed inset-0 z-50 grid place-items-center bg-stage/80 p-4 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      onClickCapture={(e) => {
        if (armed.current) return
        e.preventDefault()
        e.stopPropagation()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="You win"
    >
      <motion.div
        className="panel relative w-full max-w-md overflow-visible px-6 pb-6 pt-20 text-center"
        initial={{ scale: 0.6, rotate: -4, y: 40 }}
        animate={{ scale: 1, rotate: 0, y: 0 }}
        exit={{ scale: 0.8, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/mascot-sticker.png"
          alt="Scratchy"
          width={150}
          height={150}
          className="absolute -top-20 left-1/2 w-36 -translate-x-1/2 animate-float drop-shadow-[0_10px_30px_rgba(252,4,168,0.6)]"
        />
        <p className="font-display text-2xl text-ink glow-pink">🎫 YOU WIN</p>
        <p className="foil-text font-display mt-1 text-5xl leading-tight sm:text-6xl">{fmtPump(total)}</p>
        <p className="font-display text-2xl text-gold">PUMP</p>
        <p className="mt-1 text-muted">{fmtUsd(total, summary.pumpUsdE18)}</p>
        <p className="mt-2 text-sm text-muted">
          {jackpot
            ? 'PROGRESSIVE JACKPOT'
            : wins.length > 1
              ? `${wins.length} winning tickets`
              : `${TIER_NAMES[best]} · ${TIER_MULTIPLE[best]}×`}
        </p>
        {byTier.length > 1 && (
          <p className="mt-1 text-xs text-muted">
            {byTier.map(({ t, n }) => `${n}× ${TIER_MULTIPLE[t]}×`).join(' · ')}
          </p>
        )}

        <div className="mt-4 rounded-xl bg-stage/60 px-4 py-3 text-sm">
          {held ? (
            <p className="text-gold">
              Held for a quick safety check — released automatically when the round ends.
            </p>
          ) : status === 'confirmed' && txSig ? (
            <p>
              ✅ In your wallet —{' '}
              <a href={solscanTx(txSig)} target="_blank" rel="noreferrer" className="text-gold underline">
                view on Solscan
              </a>
            </p>
          ) : (
            <p className="text-muted">
              <span className="inline-block animate-pulse">⚡</span> sending PUMP to your wallet…
            </p>
          )}
        </div>

        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <a
            className="btn-gold text-center text-lg"
            href={flexUrl(best, jackpot)}
            target="_blank"
            rel="noreferrer"
          >
            FLEX ON X
          </a>
          <button type="button" className="btn-ghost" onClick={onClose}>
            keep scratching
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { fmtPump, fmtUsd, solscanTx } from '@/lib/money'
import { flexUrl } from './WinModal'
import { usePayoutStatus } from './usePayoutStatus'

/** Full-screen jackpot takeover (PLAN §6): siren lights, giant foil JACKPOT, the mascot, the payout. */
export function JackpotTakeover({
  win,
  onClose,
}: {
  win: { amountRaw: string; payoutId: string | null; pumpUsdE18: string | null } | null
  onClose: () => void
}) {
  return <AnimatePresence>{win && <Body key="jp" win={win} onClose={onClose} />}</AnimatePresence>
}

function Body({
  win,
  onClose,
}: {
  win: { amountRaw: string; payoutId: string | null; pumpUsdE18: string | null }
  onClose: () => void
}) {
  const { status, txSig } = usePayoutStatus(win.payoutId)
  return (
    <motion.div
      className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-4 overflow-hidden bg-stage/90 p-6 text-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-modal="true"
      aria-label="Jackpot"
    >
      <div className="siren" aria-hidden />
      <motion.img
        src="/brand/mascot-sticker.png"
        alt="Scratchy"
        className="w-48 sm:w-64"
        initial={{ scale: 0, rotate: -180 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 140, damping: 10 }}
      />
      <motion.h2
        className="foil-text font-display text-7xl sm:text-9xl"
        initial={{ scale: 3, opacity: 0 }}
        animate={{ scale: [3, 0.9, 1.05, 1], opacity: 1 }}
        transition={{ duration: 0.9 }}
      >
        JACKPOT
      </motion.h2>
      <p className="font-display text-4xl text-ink glow-gold sm:text-6xl">{fmtPump(win.amountRaw)} PUMP</p>
      <p className="text-lg text-muted">{fmtUsd(win.amountRaw, win.pumpUsdE18)}</p>
      <p className="text-sm text-muted">
        {status === 'confirmed' && txSig ? (
          <a href={solscanTx(txSig)} target="_blank" rel="noreferrer" className="text-gold underline">
            ✅ paid — view on Solscan
          </a>
        ) : (
          '⚡ paying out to your wallet…'
        )}
      </p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <a className="btn-gold text-xl" href={flexUrl(5, true)} target="_blank" rel="noreferrer">
          FLEX ON X
        </a>
        <button type="button" className="btn-ghost" onClick={onClose}>
          close
        </button>
      </div>
    </motion.div>
  )
}

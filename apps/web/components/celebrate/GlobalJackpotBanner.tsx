'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import { useLiveEvent } from '@/lib/live'
import { fmtPump, fmtUsd, shortWallet } from '@/lib/money'
import { play } from '@/lib/sfx/sound'

/** Everyone on the site sees "JACKPOT HIT" when anyone hits it (websocket `jackpot` event). */
export function GlobalJackpotBanner({ myWallet }: { myWallet: string | null }) {
  const [hit, setHit] = useState<{ who: string; amountRaw: string; pumpUsdE18: string | null } | null>(null)
  useLiveEvent((e) => {
    if (e.type !== 'jackpot' || e.wallet === myWallet) return
    setHit({
      who: e.xHandle ? `@${e.xHandle}` : shortWallet(e.wallet),
      amountRaw: e.amountRaw,
      pumpUsdE18: e.pumpUsdE18,
    })
    play('siren')
    setTimeout(() => setHit(null), 12_000)
  })
  return (
    <AnimatePresence>
      {hit && (
        <motion.div
          className="fixed inset-x-0 top-0 z-[65] flex items-center justify-center gap-3 bg-gradient-to-r from-pink via-electric to-pink px-4 py-3 text-center font-display text-lg text-ink shadow-[0_10px_40px_rgba(252,4,168,0.7)]"
          initial={{ y: -80 }}
          animate={{ y: 0 }}
          exit={{ y: -80 }}
          role="status"
        >
          🚨 JACKPOT HIT — {hit.who} just won {fmtPump(hit.amountRaw)} PUMP{' '}
          {fmtUsd(hit.amountRaw, hit.pumpUsdE18) && `(${fmtUsd(hit.amountRaw, hit.pumpUsdE18)})`} 🚨
        </motion.div>
      )}
    </AnimatePresence>
  )
}

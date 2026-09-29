'use client'

import { useState } from 'react'
import { enableMotion } from '@/components/scratch/motion'
import { play, unlockAudio } from '@/lib/sfx/sound'

/** Paste a wallet (+ optional X handle). No connect, no signature — payouts only ever go to this wallet. */
export function WalletPaste({
  initialWallet,
  initialHandle,
  busy,
  error,
  onSubmit,
}: {
  initialWallet: string
  initialHandle: string
  busy: boolean
  error: string | null
  onSubmit: (wallet: string, handle: string) => void
}) {
  const [wallet, setWallet] = useState(initialWallet)
  const [handle, setHandle] = useState(initialHandle)
  return (
    <form
      className="panel flex flex-col gap-3 p-4 sm:p-5"
      onSubmit={(e) => {
        e.preventDefault()
        void unlockAudio().then(() => play('click'))
        void enableMotion()
        onSubmit(wallet.trim(), handle.trim().replace(/^@/, ''))
      }}
    >
      <label className="text-xs uppercase tracking-[0.2em] text-muted" htmlFor="wallet">
        Paste your Solana wallet
      </label>
      <input
        id="wallet"
        className="w-full rounded-xl border border-magenta/40 bg-stage/80 px-4 py-3 font-mono text-sm text-ink outline-none placeholder:text-muted/50 focus:border-gold"
        placeholder="e.g. 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
        value={wallet}
        onChange={(e) => setWallet(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        inputMode="text"
      />
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          className="w-full rounded-xl border border-magenta/25 bg-stage/80 px-4 py-2.5 text-sm text-ink outline-none placeholder:text-muted/50 focus:border-gold sm:w-1/2"
          placeholder="@yourXhandle (optional)"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          maxLength={16}
          autoComplete="off"
        />
        <button
          type="submit"
          className="btn-gold w-full text-lg sm:w-1/2"
          disabled={busy || wallet.trim().length < 32}
        >
          {busy ? 'CHECKING…' : "LET'S SCRATCH"}
        </button>
      </div>
      {error && <p className="text-sm text-pink">{error}</p>}
      <p className="text-xs text-muted">
        No wallet connect, no signature. Prizes are sent only to the wallet you paste — there’s nothing to
        steal.
      </p>
    </form>
  )
}

'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { celebrateJackpot, celebrateWin } from '@/components/celebrate/effects'
import { JackpotTakeover } from '@/components/celebrate/JackpotTakeover'
import { WinModal, type WinSummary } from '@/components/celebrate/WinModal'
import { ScratchTicket } from '@/components/scratch/ScratchTicket'
import { SlotSymbol } from '@/components/scratch/Symbols'
import { api, ApiError } from '@/lib/api'
import { useLive, useLiveEvent, useServerNow } from '@/lib/live'
import { fmtPump } from '@/lib/money'
import { savedHandle, savedWallet, saveHandle, saveWallet } from '@/lib/session'
import { play } from '@/lib/sfx/sound'
import type { EnterResult, TicketOutcome, TicketView } from '@/lib/types'
import { EligibilityCard } from './EligibilityCard'
import { countdownText } from './StatsBand'
import { WalletPaste } from './WalletPaste'

/**
 * The play flow: paste → (first drop) → scratch the focused ticket (live canvas) → celebrate → next.
 * The tray shows static mini tickets (no canvas) so a 100-ticket whale stays at 60 fps (audit WEB-04).
 */
type Local = TicketView & {
  outcome: TicketOutcome | null
  state: 'fresh' | 'revealing' | 'revealed' | 'void'
}

const PRACTICE: TicketOutcome = {
  ticketId: 'practice',
  roundId: 0,
  idx: 0,
  tier: 2,
  jackpot: false,
  prizeRaw: '0',
  jackpotPrizeRaw: '0',
  symbols: ['bag', 'bag', 'bag'],
  payoutId: null,
  jackpotPayoutId: null,
  held: false,
}

export function PlayArea({ onWallet }: { onWallet: (w: string | null) => void }) {
  const live = useLive()
  const now = useServerNow(500)
  const [wallet, setWallet] = useState<string | null>(null)
  // remembered inputs (localStorage) — read after hydration without a set-state-in-effect round trip
  const initialWallet = useSyncExternalStore(
    noSubscribe,
    () => savedWallet() ?? '',
    () => '',
  )
  const initialHandle = useSyncExternalStore(
    noSubscribe,
    () => savedHandle() ?? '',
    () => '',
  )
  const [result, setResult] = useState<EnterResult | null>(null)
  const [tickets, setTickets] = useState<Local[]>([])
  const [focus, setFocus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [summary, setSummary] = useState<WinSummary | null>(null)
  const [jackpotWin, setJackpotWin] = useState<{
    amountRaw: string
    payoutId: string | null
    pumpUsdE18: string | null
  } | null>(null)
  const [scratchAll, setScratchAll] = useState(false)
  const [lossNudge, setLossNudge] = useState(false)
  const lossTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [practiceKey, setPracticeKey] = useState(0)
  const price = live.snapshot?.prices.pumpUsdE18 ?? null
  const walletRef = useRef<string | null>(null)

  const load = useCallback(
    async (w: string, handle?: string | null) => {
      setBusy(true)
      setError(null)
      try {
        const r = await api.enter(w, handle)
        setResult(r)
        setWallet(r.wallet)
        walletRef.current = r.wallet
        onWallet(r.wallet)
        live.watch(r.wallet)
        saveWallet(r.wallet)
        if (handle !== undefined) saveHandle(handle || null)
        const ts: Local[] = (r.entry?.tickets ?? []).map((t) => ({
          ...t,
          outcome: t.outcome,
          state: t.void ? 'void' : t.scratched ? 'revealed' : 'fresh',
        }))
        setTickets(ts)
        setFocus(ts.find((t) => t.state === 'fresh')?.id ?? null)
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Could not reach the server — try again in a moment.')
      } finally {
        setBusy(false)
      }
    },
    [live, onWallet],
  )

  // returning player: pick the saved wallet back up
  useEffect(() => {
    const w = savedWallet()
    if (w) void Promise.resolve().then(() => load(w)) // async kick-off: the fetch sets state when it resolves
  }, [load])

  useLiveEvent((e) => {
    const w = walletRef.current
    if (!w) return
    if (e.type === 'drop') {
      play('drop')
      setNotice(e.skipped ? 'This drop was skipped while the prize pool refills.' : '🎫 NEW TICKETS DROPPED!')
      setTimeout(() => setNotice(null), 4_000)
      setTimeout(() => void load(w), 400)
    } else if (e.type === 'void' && e.wallet === w) {
      setTickets((ts) => ts.map((t) => (t.state === 'fresh' ? { ...t, state: 'void' } : t)))
      setNotice(e.reason)
    }
  })

  // locked by another tab/device: quietly retry until its lease lapses
  const lockedWallet = result?.locked ? wallet : null
  useEffect(() => {
    if (!lockedWallet) return
    const t = setInterval(() => void load(lockedWallet), 10_000)
    return () => clearInterval(t)
  }, [lockedWallet, load])

  const remaining = useMemo(() => tickets.filter((t) => t.state === 'fresh'), [tickets])
  const focused = tickets.find((t) => t.id === focus) ?? null

  const advance = useCallback(() => {
    setTickets((ts) => {
      const next = ts.find((t) => t.state === 'fresh' && t.id !== focus)
      setFocus(next?.id ?? null)
      return ts
    })
  }, [focus])

  const reveal = useCallback(async (ids: string[]) => {
    const w = walletRef.current
    if (!w) return null
    setTickets((ts) => ts.map((t) => (ids.includes(t.id) ? { ...t, state: 'revealing' } : t)))
    try {
      const res = await api.scratch(ids, w)
      const byId = new Map(res.outcomes.map((o) => [o.ticketId, o]))
      setTickets((ts) => ts.map((t) => (byId.has(t.id) ? { ...t, outcome: byId.get(t.id)! } : t)))
      return res.outcomes
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'error'
      if (code === 'voided')
        setTickets((ts) => ts.map((t) => (t.state !== 'revealed' ? { ...t, state: 'void' } : t)))
      else if (code === 'locked') setNotice("this wallet's tickets are being scratched")
      else if (code === 'not_live') setNotice('That round just ended — new tickets drop now.')
      else setNotice(e instanceof Error ? e.message : 'scratch failed — try again')
      setTickets((ts) =>
        ts.map((t) =>
          ids.includes(t.id) && t.state === 'revealing'
            ? { ...t, state: code === 'voided' ? 'void' : 'fresh' }
            : t,
        ),
      )
      return null
    }
  }, [])

  const celebrate = useCallback(
    (outcomes: TicketOutcome[]) => {
      const jp = outcomes.find((o) => BigInt(o.jackpotPrizeRaw) > 0n)
      const wins = outcomes.filter((o) => o.tier > 0 || BigInt(o.jackpotPrizeRaw) > 0n)
      if (jp) {
        celebrateJackpot()
        setJackpotWin({ amountRaw: jp.jackpotPrizeRaw, payoutId: jp.jackpotPayoutId, pumpUsdE18: price })
        return
      }
      if (wins.length) {
        celebrateWin(wins.reduce((m, o) => Math.max(m, o.tier), 1))
        setSummary({ outcomes: wins, pumpUsdE18: price })
      } else {
        play('lose')
        setLossNudge(true)
        if (lossTimer.current) clearTimeout(lossTimer.current)
        lossTimer.current = setTimeout(() => setLossNudge(false), 6_000)
      }
    },
    [price],
  )

  // focused ticket fully revealed
  const onRevealed = useCallback(
    (id: string) => {
      setTickets((ts) => {
        const t = ts.find((x) => x.id === id)
        if (t?.outcome) celebrate([t.outcome])
        return ts.map((x) => (x.id === id ? { ...x, state: 'revealed' } : x))
      })
      setTimeout(advance, 700)
    },
    [advance, celebrate],
  )

  const doScratchAll = useCallback(async () => {
    const ids = remaining.map((t) => t.id)
    if (!ids.length) return
    setScratchAll(true)
    play('flip')
    const outcomes = await reveal(ids)
    if (!outcomes) {
      setScratchAll(false)
      return
    }
    // fast-stacked reveals: flip the tray one by one, then one summary + one celebration
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!
      setTimeout(
        () => setTickets((ts) => ts.map((t) => (t.id === id ? { ...t, state: 'revealed' } : t))),
        60 + i * Math.max(25, 140 - ids.length),
      )
    }
    setTimeout(
      () => {
        setScratchAll(false)
        setFocus(null)
        celebrate(outcomes)
      },
      160 + ids.length * Math.max(25, 140 - ids.length),
    )
  }, [remaining, reveal, celebrate])

  const nextDropMs = result ? Date.parse(result.nextDropAt) - now : null

  if (!wallet || !result) {
    return (
      <div className="flex flex-col gap-4">
        <WalletPaste
          key={`${initialWallet}|${initialHandle}`}
          initialWallet={initialWallet}
          initialHandle={initialHandle}
          busy={busy}
          error={error}
          onSubmit={(w, h) => void load(w, h)}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2 text-sm">
        <p className="truncate text-muted">
          Playing as{' '}
          <span className="font-mono text-ink">
            {wallet.slice(0, 4)}…{wallet.slice(-4)}
          </span>
          {result.xHandle && <span className="ml-1 text-magenta">@{result.xHandle}</span>}
        </p>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => {
            saveWallet(null)
            setWallet(null)
            setResult(null)
            setTickets([])
            walletRef.current = null
            onWallet(null)
            live.watch(null)
          }}
        >
          change wallet
        </button>
      </div>
      <EligibilityCard r={result} />
      {notice && <p className="panel px-4 py-2 text-center font-display text-gold">{notice}</p>}

      {result.locked ? (
        <div className="panel p-6 text-center">
          <p className="font-display text-xl">this wallet&apos;s tickets are being scratched</p>
          <p className="mt-1 text-sm text-muted">
            Another tab or device has them right now. They free up here automatically about 45 seconds after
            that one goes quiet.
          </p>
          <button type="button" className="btn-pink mt-4" onClick={() => void load(wallet)}>
            try again
          </button>
        </div>
      ) : tickets.length === 0 ? (
        <div className="grid items-center gap-5 md:grid-cols-2">
          <div className="panel p-6 text-center">
            <p className="text-xs uppercase tracking-[0.2em] text-muted">
              {result.eligibleNow ? 'your first tickets drop in' : 'next drop in'}
            </p>
            <p className="font-display mt-1 text-5xl tabular-nums glow-pink">
              {nextDropMs === null ? '–:––' : countdownText(nextDropMs)}
            </p>
            <p className="mt-3 text-sm text-muted">
              {result.eligibleNow
                ? `Keep this tab open — you're in for ${result.ticketsPerDrop} tickets at the next drop. Warm up on a practice ticket meanwhile.`
                : 'Hold at least $50 of $SCRATCHY and keep this tab open to get tickets every drop.'}
            </p>
          </div>
          <div>
            <ScratchTicket
              key={`practice-${practiceKey}`}
              label="PRACTICE"
              practice
              outcome={PRACTICE}
              onRevealed={() => {
                play('win2')
                setTimeout(() => setPracticeKey((k) => k + 1), 1_800)
              }}
            />
            <p className="mt-2 text-center text-xs text-muted">Practice ticket — no prize, just the feel.</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {focused && focused.state !== 'void' && !scratchAll ? (
            <ScratchTicket
              key={focused.id}
              label={`#${focused.idx + 1} · ROUND ${result.round?.id ?? ''}`}
              outcome={focused.outcome}
              revealed={focused.state === 'revealed'}
              pumpUsdE18={price}
              onStart={() => void reveal([focused.id])}
              onRevealed={() => onRevealed(focused.id)}
            />
          ) : remaining.length === 0 ? (
            <div className="panel p-6 text-center">
              <p className="font-display text-2xl">All scratched!</p>
              <p className="mt-1 text-muted">
                Next drop in{' '}
                <span className="font-display text-ink">
                  {nextDropMs === null ? '–:––' : countdownText(nextDropMs)}
                </span>
              </p>
            </div>
          ) : null}

          {lossNudge && remaining.length === 0 && (
            <p className="text-center text-sm text-muted">
              Not this time — next drop in {nextDropMs === null ? '–:––' : countdownText(nextDropMs)}.{' '}
              {BigInt(result.nudge.extraTickets) > 0n &&
                `+$${result.nudge.extraUsd} more of $SCRATCHY = +${result.nudge.extraTickets} tickets per drop.`}
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted">
              <span className="font-display text-ink">{remaining.length}</span> of {tickets.length} left this
              round
            </p>
            {remaining.length > 1 && (
              <button
                type="button"
                className="btn-pink"
                disabled={scratchAll}
                onClick={() => void doScratchAll()}
              >
                SCRATCH ALL
              </button>
            )}
          </div>
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-8 md:grid-cols-10">
            {tickets.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`mini-ticket ${t.state === 'revealed' ? 'mini-flip' : ''}`}
                data-state={t.state === 'revealed' ? 'revealed' : t.state === 'void' ? 'void' : 'fresh'}
                data-focus={t.id === focus ? 'true' : undefined}
                disabled={t.state !== 'fresh' || scratchAll}
                onClick={() => setFocus(t.id)}
                aria-label={`ticket ${t.idx + 1}${t.state === 'revealed' ? ' revealed' : ''}`}
              >
                <span className="mini-face">
                  {t.state === 'revealed' && t.outcome ? (
                    t.outcome.tier > 0 || BigInt(t.outcome.jackpotPrizeRaw) > 0n ? (
                      <span className="flex flex-col items-center">
                        <SlotSymbol symbol={t.outcome.symbols[0]} size={26} />
                        <span className="mt-0.5 font-display text-[10px] leading-none text-[#3a0b5e]">
                          {fmtPump(BigInt(t.outcome.prizeRaw) + BigInt(t.outcome.jackpotPrizeRaw))}
                        </span>
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold text-[#6d4a8f]">—</span>
                    )
                  ) : t.state === 'void' ? (
                    <span className="text-[10px] font-bold text-[#3a0b5e]">VOID</span>
                  ) : (
                    <span className="font-display text-xs text-[#6d4a8f]">#{t.idx + 1}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
          {result.entry?.voided && <p className="text-center text-sm text-pink">{result.entry.voided}</p>}
        </div>
      )}

      <WinModal summary={summary} onClose={() => setSummary(null)} />
      <JackpotTakeover win={jackpotWin} onClose={() => setJackpotWin(null)} />
    </div>
  )
}

const noSubscribe = () => () => {}

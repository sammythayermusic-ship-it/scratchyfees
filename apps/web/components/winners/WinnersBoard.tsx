'use client'

import { MotionConfig } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useLive, useLiveEvent, useServerNow } from '@/lib/live'
import type { WinnerRow } from '@/lib/types'
import { BiggestWall } from './BiggestWall'
import { FINAL_PAYOUT_STATUSES, type WinnersPage, type WinnersStats } from './format'
import { WinFeed, type FeedRow } from './WinFeed'
import { WinnerStats } from './WinnerStats'

type Load = 'loading' | 'ready' | 'error'
interface Feed {
  rows: FeedRow[]
  nextBefore: string | null
}

/** While any of the newest rows still has a payout in flight, re-read the first page this often. */
const POLL_MS = 8_000
const PENDING_WINDOW = 30

const fetchBoard = () => Promise.allSettled([api.winners(), api.stats()])
type BoardResult = Awaited<ReturnType<typeof fetchBoard>>

const sameWin = (a: WinnerRow, b: WinnerRow) =>
  a.roundId === b.roundId &&
  a.wallet === b.wallet &&
  a.tier === b.tier &&
  a.prizeRaw === b.prizeRaw &&
  a.jackpotPrizeRaw === b.jackpotPrizeRaw

/**
 * Fold a fresh first page into the feed. Row keys stay stable (a live placeholder hands its key to the
 * server row it turned into, so nothing re-animates), older loaded pages are kept, and placeholders the
 * server doesn't know about yet survive until the next read.
 */
function mergeHead(prev: Feed, page: WinnersPage): Feed {
  const keyByTicket = new Map(prev.rows.filter((r) => !r.live).map((r) => [r.ticketId, r.k]))
  const placeholders = prev.rows.filter((r) => r.live)
  const claimed = new Set<string>()
  const fresh = page.recent.map<FeedRow>((r) => {
    const known = keyByTicket.get(r.ticketId)
    if (known) return { ...r, k: known }
    const twin = placeholders.find((p) => !claimed.has(p.k) && (p.ticketId === r.ticketId || sameWin(p, r)))
    if (twin) {
      claimed.add(twin.k)
      return { ...r, k: twin.k }
    }
    return { ...r, k: r.ticketId }
  })
  const newestAt = fresh[0] ? Date.parse(fresh[0].at) : 0
  const stillLive = placeholders.filter((p) => !claimed.has(p.k) && Date.parse(p.at) > newestAt)
  const oldest = fresh.at(-1)
  const older = prev.rows.filter((r) => !r.live && (!oldest || BigInt(r.ticketId) < BigInt(oldest.ticketId)))
  return {
    rows: [...stillLive, ...fresh, ...older],
    nextBefore: older.length > 0 ? prev.nextBefore : page.nextBefore,
  }
}

function appendPage(prev: Feed, page: WinnersPage): Feed {
  const seen = new Set(prev.rows.map((r) => r.ticketId))
  const more = page.recent.filter((r) => !seen.has(r.ticketId)).map<FeedRow>((r) => ({ ...r, k: r.ticketId }))
  return { rows: [...prev.rows, ...more], nextBefore: page.nextBefore }
}

/** /winners: all-time stats, the biggest-wins wall and the live feed (websocket + light polling for payout status). */
export function WinnersBoard() {
  const { snapshot, connected } = useLive()
  const now = useServerNow(15_000)
  const price = snapshot?.prices.pumpUsdE18 ?? null
  const [feed, setFeed] = useState<Feed>({ rows: [], nextBefore: null })
  const [biggest, setBiggest] = useState<WinnerRow[]>([])
  const [stats, setStats] = useState<WinnersStats | null>(null)
  const [winnersState, setWinnersState] = useState<Load>('loading')
  const [statsState, setStatsState] = useState<Load>('loading')
  const [moreState, setMoreState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [version, setVersion] = useState(0)

  const apply = useCallback(([w, s]: BoardResult) => {
    if (w.status === 'fulfilled') {
      setFeed((f) => mergeHead(f, w.value))
      setBiggest(w.value.biggest)
      setWinnersState('ready')
    } else {
      setWinnersState((st) => (st === 'ready' ? st : 'error'))
    }
    if (s.status === 'fulfilled') {
      setStats(s.value)
      setStatsState('ready')
    } else {
      setStatsState((st) => (st === 'ready' ? st : 'error'))
    }
    setVersion((v) => v + 1)
  }, [])

  useEffect(() => {
    let alive = true
    fetchBoard().then((r) => {
      if (alive) apply(r)
    })
    return () => {
      alive = false
    }
  }, [apply])

  // Live wins arrive without a tx yet; keep re-reading the first page until their payouts settle.
  const pending = feed.rows
    .slice(0, PENDING_WINDOW)
    .some((r) => r.live || (r.payoutStatus !== null && !FINAL_PAYOUT_STATUSES.has(r.payoutStatus)))
  useEffect(() => {
    if (!pending) return
    let alive = true
    const t = setTimeout(() => {
      if (document.visibilityState === 'hidden') {
        setVersion((v) => v + 1) // skip while hidden, check again next tick
        return
      }
      fetchBoard().then((r) => {
        if (alive) apply(r)
      })
    }, POLL_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [pending, version, apply])

  useLiveEvent((e) => {
    if (e.type !== 'winner') return
    const id = `live-${e.roundId}-${e.at}-${Math.random().toString(36).slice(2)}`
    const row: FeedRow = {
      k: id,
      live: true,
      ticketId: e.ticketId ?? id,
      roundId: e.roundId,
      wallet: e.wallet,
      xHandle: e.xHandle,
      tier: e.tier,
      multMicro: e.multMicro && e.multMicro !== '0' ? e.multMicro : null,
      prizeRaw: e.prizeRaw,
      jackpotPrizeRaw: e.jackpotPrizeRaw,
      at: e.at,
      txSig: null,
      payoutStatus: null,
      pumpUsdE18: e.pumpUsdE18,
    }
    setFeed((f) => ({ ...f, rows: [row, ...f.rows] }))
    setWinnersState('ready')
  })

  const loadMore = () => {
    const before = feed.nextBefore
    if (!before || moreState === 'loading') return
    setMoreState('loading')
    api.winners(before).then(
      (w) => {
        setFeed((f) => appendPage(f, w))
        setMoreState('idle')
      },
      () => setMoreState('error'),
    )
  }

  const retry = () => {
    setWinnersState((st) => (st === 'ready' ? st : 'loading'))
    setStatsState((st) => (st === 'ready' ? st : 'loading'))
    void fetchBoard().then(apply)
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col gap-6">
        <WinnerStats stats={stats} state={statsState} price={price} onRetry={retry} />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)] lg:items-start">
          <div className="order-2 min-w-0 lg:order-1">
            <WinFeed
              rows={feed.rows}
              state={winnersState}
              now={now}
              connected={connected}
              nextBefore={feed.nextBefore}
              moreState={moreState}
              onMore={loadMore}
              onRetry={retry}
            />
          </div>
          <div className="order-1 min-w-0 lg:order-2">
            <BiggestWall rows={biggest} state={winnersState} now={now} />
          </div>
        </div>
      </div>
    </MotionConfig>
  )
}

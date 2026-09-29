'use client'

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { api } from './api'
import { WS_URL } from './config'
import { sessionId } from './session'
import type { LiveEvent, RoundSnapshot } from './types'

/**
 * One websocket for the whole site (PLAN §3 live updates): pool, jackpot meter, countdown and winner events
 * for everyone; payout status for the watched wallet. Reconnects with backoff, falls back to polling
 * /api/round, keeps a server-clock offset so every countdown agrees with the drop boundary, and sends a
 * heartbeat only while the tab is visible (Decision C: being on the site keeps a wallet entered).
 */

type Listener = (e: LiveEvent) => void

interface LiveState {
  snapshot: RoundSnapshot | null
  connected: boolean
  /** server time − local time, ms */
  clockOffset: number
  watch(wallet: string | null): void
  on(listener: Listener): () => void
  refresh(): Promise<void>
}

const LiveCtx = createContext<LiveState | null>(null)

export function LiveProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<RoundSnapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [clockOffset, setClockOffset] = useState(0)
  const listeners = useRef(new Set<Listener>())
  const walletRef = useRef<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const applyServerTime = useCallback((iso: string) => setClockOffset(Date.parse(iso) - Date.now()), [])

  const refresh = useCallback(async () => {
    try {
      const s = await api.round(walletRef.current)
      setSnapshot(s)
      applyServerTime(s.serverTime)
    } catch {
      /* offline: the websocket reconnect loop keeps trying */
    }
  }, [applyServerTime])

  useEffect(() => {
    let stopped = false
    let attempt = 0
    let hb: ReturnType<typeof setInterval> | null = null
    let poll: ReturnType<typeof setInterval> | null = null

    const connect = () => {
      if (stopped) return
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws
      ws.onopen = () => {
        attempt = 0
        setConnected(true)
        ws.send(JSON.stringify({ type: 'hello', session: sessionId(), wallet: walletRef.current }))
      }
      ws.onmessage = (m) => {
        let e: LiveEvent
        try {
          e = JSON.parse(String(m.data)) as LiveEvent
        } catch {
          return
        }
        if (e.type === 'snapshot') {
          const { type: _t, ...snap } = e
          setSnapshot(snap)
          applyServerTime(snap.serverTime)
        } else if (e.type === 'tick') {
          applyServerTime(e.serverTime)
          setSnapshot((s) =>
            s ? { ...s, pool: e.pool, prices: e.prices, paused: e.paused, round: e.round ?? s.round } : s,
          )
        } else if (e.type === 'drop' || e.type === 'round_end') {
          void refresh()
        }
        for (const l of listeners.current) l(e)
      }
      ws.onclose = () => {
        setConnected(false)
        wsRef.current = null
        if (stopped) return
        attempt++
        setTimeout(connect, Math.min(15_000, 500 * 2 ** attempt))
      }
      ws.onerror = () => ws.close()
    }

    void refresh()
    connect()
    // visible-tab heartbeat (Decision C) + a slow poll as a safety net
    hb = setInterval(() => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN && document.visibilityState === 'visible') {
        ws.send(JSON.stringify({ type: 'hb', visible: true, wallet: walletRef.current }))
      }
    }, 20_000)
    poll = setInterval(() => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) void refresh()
    }, 15_000)
    return () => {
      stopped = true
      if (hb) clearInterval(hb)
      if (poll) clearInterval(poll)
      wsRef.current?.close()
    }
  }, [refresh, applyServerTime])

  const value = useMemo<LiveState>(
    () => ({
      snapshot,
      connected,
      clockOffset,
      watch(wallet) {
        walletRef.current = wallet
        const ws = wsRef.current
        if (ws?.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'watch', session: sessionId(), wallet }))
      },
      on(listener) {
        listeners.current.add(listener)
        return () => listeners.current.delete(listener)
      },
      refresh,
    }),
    [snapshot, connected, clockOffset, refresh],
  )
  return <LiveCtx.Provider value={value}>{children}</LiveCtx.Provider>
}

export function useLive(): LiveState {
  const v = useContext(LiveCtx)
  if (!v) throw new Error('useLive outside LiveProvider')
  return v
}

/** Subscribe to live events; the handler may change between renders without resubscribing. */
export function useLiveEvent(handler: Listener): void {
  const { on } = useLive()
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => on((e) => ref.current(e)), [on])
}

/** Server-synced "now" that re-renders every `ms`. */
export function useServerNow(ms = 250): number {
  const { clockOffset } = useLive()
  const [now, setNow] = useState(() => Date.now() + clockOffset)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + clockOffset), ms)
    return () => clearInterval(t)
  }, [clockOffset, ms])
  return now
}

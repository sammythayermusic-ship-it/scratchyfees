'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, ApiError } from '@/lib/api'
import { API_ORIGIN } from '@/lib/config'
import type { AdminStatus } from './types'

/**
 * Admin token + admin API plumbing.
 *
 * The ADMIN_TOKEN lives in this tab's sessionStorage only (never localStorage, never a URL, never rendered) and
 * is only ever sent as the `Authorization: Bearer` header to API_ORIGIN via lib/api's `api.admin`. If
 * sessionStorage is unavailable it is kept in memory for this page load only.
 */

const TOKEN_KEY = 'scratchy.admin-token'
let memoryToken: string | null = null
const tokenListeners = new Set<() => void>()

function readToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return memoryToken
  }
}

export function setAdminToken(token: string | null): void {
  memoryToken = token
  try {
    if (token === null) window.sessionStorage.removeItem(TOKEN_KEY)
    else window.sessionStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* storage blocked: memory only */
  }
  for (const l of tokenListeners) l()
}

function subscribeToken(listener: () => void): () => void {
  tokenListeners.add(listener)
  return () => tokenListeners.delete(listener)
}

const noopSubscribe = () => () => {}

/** `hydrated` is false during SSR / hydration so the page never flashes the wrong screen. */
export function useAdminToken(): { token: string | null; hydrated: boolean } {
  const token = useSyncExternalStore(subscribeToken, readToken, () => null)
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  )
  return { token, hydrated }
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => !document.hidden,
    () => true,
  )
}

/** Error text for the UI: the API's own message verbatim, prefixed with HTTP status + error code. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return `${e.status} ${e.code}: ${e.message}`
  if (e instanceof Error) return `network error (${API_ORIGIN}): ${e.message}`
  return String(e)
}

export const adminGet = <T>(path: string, token: string) => api.admin<T>(path, token)

/** Always sends a JSON body (Fastify rejects an empty body with content-type: application/json). */
export const adminPost = <T>(path: string, token: string, body: Record<string, unknown> = {}) =>
  api.admin<T>(path, token, { method: 'POST', body: JSON.stringify(body) })

export interface StatusState {
  status: AdminStatus | null
  error: { text: string; httpStatus: number | null } | null
  /** local ms timestamp of the last successful fetch */
  okAt: number | null
  loading: boolean
  visible: boolean
  refresh: () => void
}

/** GET /api/admin/status every `intervalMs` while the tab is visible; immediately on becoming visible. */
export function useAdminStatus(token: string, intervalMs = 5_000): StatusState {
  const [status, setStatus] = useState<AdminStatus | null>(null)
  const [error, setError] = useState<StatusState['error']>(null)
  const [okAt, setOkAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const visible = usePageVisible()
  const inflight = useRef(false)
  const again = useRef(false)

  const refresh = useCallback(() => {
    if (inflight.current) {
      again.current = true
      return
    }
    inflight.current = true
    const run = async () => {
      setLoading(true)
      do {
        again.current = false
        try {
          const s = await adminGet<AdminStatus>('/status', token)
          setStatus(s)
          setError(null)
          setOkAt(Date.now())
        } catch (e) {
          setError({ text: errorText(e), httpStatus: e instanceof ApiError ? e.status : null })
        }
      } while (again.current)
      inflight.current = false
      setLoading(false)
    }
    void run()
  }, [token])

  useEffect(() => {
    if (!visible) return
    const first = setTimeout(refresh, 0)
    const id = setInterval(refresh, intervalMs)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [refresh, intervalMs, visible])

  return { status, error, okAt, loading, visible, refresh }
}

/** A clock for "12s ago" labels (0 until the first tick after mount). */
export function useNow(ms = 1_000): number {
  const [now, setNow] = useState(0)
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const id = setInterval(tick, ms)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [ms])
  return now
}

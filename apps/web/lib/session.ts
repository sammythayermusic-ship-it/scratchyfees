/**
 * Per-TAB session id (sessionStorage: survives reloads of this tab, a new tab gets its own) — the server's
 * one-scratcher-per-wallet lock is keyed by it, so a second tab sees "this wallet's tickets are being scratched".
 * The pasted wallet / X handle are remembered per browser (localStorage).
 */
const SESSION_KEY = 'scratchy.session'
const WALLET_KEY = 'scratchy.wallet'
const HANDLE_KEY = 'scratchy.handle'

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function safeSet(k: string, v: string | null): void {
  try {
    if (v === null) localStorage.removeItem(k)
    else localStorage.setItem(k, v)
  } catch {
    /* private mode: fine, we just don't remember */
  }
}

let memorySession: string | null = null

function tabGet(k: string): string | null {
  try {
    return sessionStorage.getItem(k)
  } catch {
    return null
  }
}
function tabSet(k: string, v: string): void {
  try {
    sessionStorage.setItem(k, v)
  } catch {
    /* private mode: the in-memory id lasts for this page load */
  }
}

export function sessionId(): string {
  const existing = tabGet(SESSION_KEY) ?? memorySession
  if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  const id = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  memorySession = id
  tabSet(SESSION_KEY, id)
  return id
}

export const savedWallet = () => safeGet(WALLET_KEY)
export const saveWallet = (w: string | null) => safeSet(WALLET_KEY, w)
export const savedHandle = () => safeGet(HANDLE_KEY)
export const saveHandle = (h: string | null) => safeSet(HANDLE_KEY, h)

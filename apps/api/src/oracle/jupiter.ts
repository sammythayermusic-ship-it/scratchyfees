import { decimalToScaled } from '@scratchy/core'
import type { UsdPriceSource } from './types'

/**
 * PUMP/USD from the Jupiter Price API v3 (PLAN §3 — the primary USD source).
 *   GET {base}/price/v3?ids=<mint>  (optional `x-api-key` header; keyless is ~0.5 rps)
 *   → { "<mint>": { "usdPrice": 0.0056652589, "decimals": 6, … } }
 * A token Jupiter has no reliable price for is simply absent from the object → null (the oracle then
 * falls back to DexScreener). Transport problems (non-2xx, timeout, malformed body) throw.
 * The float is converted to USD × 1e18 exactly from its shortest decimal representation.
 */

export const PRICE_FETCH_TIMEOUT_MS = 5_000

/** The subset of `fetch` the price sources use (injected so tests never touch the network). */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** GET a JSON document with a hard timeout; non-2xx responses throw (the status is in the message). */
export async function fetchJsonWithTimeout(
  fetchImpl: FetchFn,
  url: string,
  headers: Record<string, string>,
  label: string,
  timeoutMs = PRICE_FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`)
    return (await res.json()) as unknown
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`${label}: timed out after ${timeoutMs}ms`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Parse a positive decimal (JS number or numeric string) into value × 1e18; null when absent/non-positive. */
export function positivePriceE18(value: unknown): bigint | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
  } else if (typeof value !== 'string' || value.trim() === '') {
    return null
  }
  let scaled: bigint
  try {
    scaled = decimalToScaled(value, 18)
  } catch {
    return null
  }
  return scaled > 0n ? scaled : null
}

export class JupiterUsdSource implements UsdPriceSource {
  readonly name = 'jupiter'
  private readonly base: string

  constructor(
    base: string,
    private readonly apiKey?: string,
    private readonly fetchImpl: FetchFn = (url, init) => fetch(url, init),
    private readonly timeoutMs = PRICE_FETCH_TIMEOUT_MS,
  ) {
    this.base = base.replace(/\/+$/, '')
  }

  async fetchUsdPriceE18(mint: string): Promise<bigint | null> {
    const url = `${this.base}/price/v3?ids=${encodeURIComponent(mint)}`
    const headers: Record<string, string> = this.apiKey ? { 'x-api-key': this.apiKey } : {}
    const body = await fetchJsonWithTimeout(this.fetchImpl, url, headers, 'jupiter price v3', this.timeoutMs)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('jupiter price v3: unexpected response shape')
    }
    const entry = (body as Record<string, unknown>)[mint]
    if (typeof entry !== 'object' || entry === null) return null
    return positivePriceE18((entry as { usdPrice?: unknown }).usdPrice)
  }
}

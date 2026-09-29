import { scaledToDecimal } from './units'

/**
 * Display formatting. The PUMP amount is exact; the "~$" is a live estimate that is allowed to drift
 * with PUMP's price (§1 payout precision) — it never sizes or delays a payout.
 */

const grouping = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

/** e.g. 12500000000n (6 dp) → "12,500"; 1234567n → "1.23"; 1234n → "0.001234" */
export function formatPump(raw: bigint, decimals: number): string {
  const whole = raw / 10n ** BigInt(decimals)
  if (whole >= 1000n) return grouping.format(whole)
  const s = scaledToDecimal(raw, decimals)
  const n = Number(s)
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (n === 0) return '0'
  return n.toLocaleString('en-US', { maximumSignificantDigits: 4 })
}

/** Compact form for tight UI (tickers, feed rows): 12.5K, 3.2M, 1.1B. */
export function formatPumpCompact(raw: bigint, decimals: number): string {
  const n = Number(scaledToDecimal(raw, decimals))
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

/** "~$42", "~$0.08", "<$0.01", or "" when no price is known. */
export function formatUsdEstimate(
  raw: bigint,
  decimals: number,
  priceUsd: number | null | undefined,
): string {
  if (priceUsd === null || priceUsd === undefined || !Number.isFinite(priceUsd) || priceUsd <= 0) return ''
  const usd = Number(scaledToDecimal(raw, decimals)) * priceUsd
  if (usd === 0) return '~$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 10) return `~$${usd.toFixed(2)}`
  return `~$${Math.round(usd).toLocaleString('en-US')}`
}

export function truncateWallet(address: string, head = 4, tail = 4): string {
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`
}

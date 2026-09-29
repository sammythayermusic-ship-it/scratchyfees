import { decimalToScaledExact, scaledToDecimal } from '@scratchy/core'
import { solscanAccount, solscanTx } from '@/lib/money'

/**
 * Admin display helpers. Raw token amounts stay BigInt end to end — no float math on money. (Prices and
 * ratios are display-only numbers.)
 */

/** exact decimal of a raw amount, e.g. "262356.829569" */
export const exactScaled = (raw: string | bigint, scale: number) =>
  scaledToDecimal(typeof raw === 'bigint' ? raw : BigInt(raw), scale)

/** grouped integer part + up to `maxFrac` fraction digits (truncated, trailing zeros dropped) */
export function fmtScaled(raw: string | bigint, scale: number, maxFrac: number): string {
  const v = typeof raw === 'bigint' ? raw : BigInt(raw)
  const neg = v < 0n
  const abs = neg ? -v : v
  const base = 10n ** BigInt(scale)
  const int = abs / base
  const frac = (abs % base).toString().padStart(scale, '0').slice(0, maxFrac).replace(/0+$/, '')
  return `${neg ? '-' : ''}${int.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`
}

/** lamports → "1.9978 SOL"-style number (4 decimals, truncated) */
export const fmtSol = (lamports: string | null) => (lamports === null ? '—' : fmtScaled(lamports, 9, 4))

/** weighted tickets W (micro units) → "144.04" */
export const fmtWeighted = (micro: string | null) => (micro === null ? '—' : fmtScaled(micro, 6, 2))

/** parts-per-million → "0.5%" */
export const ppmToPercent = (ppm: string | bigint) =>
  `${scaledToDecimal(typeof ppm === 'bigint' ? ppm : BigInt(ppm), 4)}%`

/** "0.005" → 5000n, or null when it is not an exact 6-decimal number */
export function rateToPpm(rate: string): bigint | null {
  try {
    return decimalToScaledExact(rate.trim(), 6)
  } catch {
    return null
  }
}

/** "0.005" → "0.5%" */
export function rateToPercent(rate: string): string {
  const ppm = rateToPpm(rate)
  return ppm === null ? '?' : ppmToPercent(ppm)
}

/** part / total as a percentage with one decimal, computed in BigInt ("70.0%") */
export function share(part: string | bigint, total: string | bigint): string {
  const p = BigInt(part)
  const t = BigInt(total)
  if (t <= 0n) return '—'
  const permille = (p * 1000n) / t
  return `${permille / 10n}.${permille % 10n}%`
}

/** price × 1e18 → human number (display only) */
export function fmtPriceE18(e18: string | null | undefined): string {
  if (!e18) return '—'
  const n = Number(scaledToDecimal(BigInt(e18), 18))
  if (n === 0) return '0'
  return n.toLocaleString('en-US', { maximumSignificantDigits: 6 })
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/** "12s ago" / "in 40s"; empty until the clock has ticked (now = 0) */
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso || !now) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = Math.round((now - t) / 1000)
  const abs = Math.abs(diff)
  const span =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.floor(abs / 60)}m`
        : abs < 86_400
          ? `${Math.floor(abs / 3600)}h ${Math.floor((abs % 3600) / 60)}m`
          : `${Math.floor(abs / 86_400)}d`
  return diff >= 0 ? `${span} ago` : `in ${span}`
}

/** explorer links are meaningless for the in-memory dev chain */
export const txHref = (sig: string, cluster: string) => (cluster === 'memory' ? null : solscanTx(sig))
export const accountHref = (addr: string, cluster: string) =>
  cluster === 'memory' ? null : solscanAccount(addr)

/** loose Solana address shape check (base58, 32–44 chars) — the API is the real judge */
export const looksLikeAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)

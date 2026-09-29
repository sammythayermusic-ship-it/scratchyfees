/**
 * Exact integer helpers. Every PUMP amount in the system is a bigint of base units ("raw").
 * Rates are parts-per-million bigints, multipliers are micro-units, USD values are micro-USD,
 * prices are USD-per-whole-token scaled by 1e18. No floats ever touch money.
 */

export const PPM = 1_000_000n
export const MICRO = 1_000_000n
export const E18 = 10n ** 18n
/** 2^53 — the range of the 53-bit uniform integers derived from HMAC digests. */
export const TWO_POW_53 = 1n << 53n

export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`pow10: invalid exponent ${n}`)
  return 10n ** BigInt(n)
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

export function clampBig(v: bigint, lo: bigint, hi: bigint): bigint {
  if (lo > hi) throw new RangeError('clampBig: lo > hi')
  return v < lo ? lo : v > hi ? hi : v
}

/** floor(a * b / c) for non-negative operands. */
export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  if (c <= 0n) throw new RangeError('mulDivFloor: divisor must be > 0')
  if (a < 0n || b < 0n) throw new RangeError('mulDivFloor: operands must be >= 0')
  return (a * b) / c
}

/** ceil(a * b / c) for non-negative operands. */
export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  if (c <= 0n) throw new RangeError('mulDivCeil: divisor must be > 0')
  if (a < 0n || b < 0n) throw new RangeError('mulDivCeil: operands must be >= 0')
  const n = a * b
  return (n + c - 1n) / c
}

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

/**
 * Parse a decimal (string or JS number) into `value * 10^scale` as a bigint, truncating toward zero.
 * Handles exponent notation such as "5.6652589e-3" (what Number#toString emits for small prices).
 */
export function decimalToScaled(value: string | number, scale: number): bigint {
  return parseDecimal(value, scale, false)
}

/** Like decimalToScaled but throws if any precision would be lost (used for config values). */
export function decimalToScaledExact(value: string | number, scale: number): bigint {
  return parseDecimal(value, scale, true)
}

function parseDecimal(value: string | number, scale: number, exact: boolean): bigint {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`not a finite number: ${value}`)
  }
  const s = (typeof value === 'number' ? value.toString() : value).trim()
  const m = DECIMAL_RE.exec(s)
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
    throw new RangeError(`not a decimal: "${s}"`)
  }
  const sign = m[1] === '-' ? -1n : 1n
  const intPart = m[2] ?? ''
  const fracPart = m[3] ?? ''
  const exp = m[4] ? Number.parseInt(m[4], 10) : 0
  const digits = BigInt((intPart + fracPart).replace(/^0+(?=\d)/, '') || '0')
  const shift = exp - fracPart.length + scale
  if (shift >= 0) return sign * digits * pow10(shift)
  const div = pow10(-shift)
  if (exact && digits % div !== 0n) {
    throw new RangeError(`"${s}" has more precision than 1e-${scale}`)
  }
  return sign * (digits / div)
}

/** Render a scaled bigint (value * 10^scale) as a plain decimal string, trimming trailing zeros. */
export function scaledToDecimal(v: bigint, scale: number): string {
  const neg = v < 0n
  const abs = neg ? -v : v
  const base = pow10(scale)
  const int = abs / base
  const frac = abs % base
  let out = int.toString()
  if (scale > 0 && frac > 0n) {
    out += '.' + frac.toString().padStart(scale, '0').replace(/0+$/, '')
  }
  return neg ? '-' + out : out
}

/** Convert raw token base units into a JS number of whole tokens (display only — never for money math). */
export function rawToNumber(raw: bigint, decimals: number): number {
  return Number(scaledToDecimal(raw, decimals))
}

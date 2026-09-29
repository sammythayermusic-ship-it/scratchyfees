import type { TierId } from './odds'

/**
 * Presentation-only derivations. None of this affects outcomes: the tier and jackpot flag come from
 * fair.ts; these helpers only choose which slot symbols / ticket art to draw for an outcome.
 */

export const SYMBOLS = ['coin', 'bag', 'bar', 'diamond', 'crown', 'seven', 'clover', 'star'] as const
export type SymbolKey = (typeof SYMBOLS)[number] | 'scratchy'

/** Three-of-a-kind symbol for each winning tier (§6: "matching symbols = your prize tier"). */
export const TIER_SYMBOL: Record<Exclude<TierId, 0>, SymbolKey> = {
  1: 'coin',
  2: 'bag',
  3: 'bar',
  4: 'diamond',
  5: 'crown',
}

/**
 * The three symbols under the foil. Winners show a triple of their tier symbol; a jackpot shows
 * three Scratchys; losers show a random non-triple drawn from bytes 16–18 of the (already revealed)
 * ticket digest — natural odds, no engineered near-misses.
 */
export function slotSymbols(
  tier: TierId,
  jackpot: boolean,
  digestHex: string,
): [SymbolKey, SymbolKey, SymbolKey] {
  if (jackpot) return ['scratchy', 'scratchy', 'scratchy']
  if (tier !== 0) {
    const s = TIER_SYMBOL[tier]
    return [s, s, s]
  }
  const byte = (i: number) => Number.parseInt(digestHex.slice(32 + i * 2, 34 + i * 2), 16)
  const a = SYMBOLS[byte(0) % SYMBOLS.length]!
  const b = SYMBOLS[byte(1) % SYMBOLS.length]!
  let c = SYMBOLS[byte(2) % SYMBOLS.length]!
  if (a === b && b === c)
    c = SYMBOLS[(SYMBOLS.indexOf(c) + 1 + (byte(3) % (SYMBOLS.length - 1))) % SYMBOLS.length]!
  return [a, b, c]
}

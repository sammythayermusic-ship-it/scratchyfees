import { formatPump, formatPumpCompact, formatUsdEstimate, TIERS } from '@scratchy/core'
import { CLUSTER, PUMP_DECIMALS } from './config'

/** Display helpers. The PUMP amount is exact; "~$" is a live estimate (PLAN §1 payout precision). */
export const pumpPrice = (e18: string | null | undefined): number | null =>
  e18 ? Number(BigInt(e18)) / 1e18 : null

export const fmtPump = (raw: string | bigint) => formatPump(BigInt(raw), PUMP_DECIMALS)
export const fmtPumpCompact = (raw: string | bigint) => formatPumpCompact(BigInt(raw), PUMP_DECIMALS)
export const fmtUsd = (raw: string | bigint, pumpUsdE18: string | null | undefined) =>
  formatUsdEstimate(BigInt(raw), PUMP_DECIMALS, pumpPrice(pumpUsdE18))

export function usdMicro(micro: string | bigint): string {
  const v = Number(BigInt(micro)) / 1e6
  return v >= 100 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${v.toFixed(2)}`
}

export const multLabel = (micro: string | bigint) =>
  `${(Number(BigInt(micro)) / 1e6).toFixed(2).replace(/\.?0+$/, '')}×`

export const solscanTx = (sig: string) =>
  `https://solscan.io/tx/${sig}${CLUSTER === 'mainnet-beta' ? '' : `?cluster=${CLUSTER === 'localnet' ? 'custom' : CLUSTER}`}`
export const solscanAccount = (addr: string) =>
  `https://solscan.io/account/${addr}${CLUSTER === 'mainnet-beta' ? '' : `?cluster=${CLUSTER}`}`

export const shortWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`

const capitalize = (s: string) => (s === s.toUpperCase() ? s : s[0]!.toUpperCase() + s.slice(1))
/** display names per tier id, derived from core's locked odds table */
export const TIER_NAMES: readonly string[] = TIERS.map((t) =>
  capitalize(t.feel === 'loser' ? 'no win' : t.feel),
)
/** tier multiple of e (for the FLEX copy "just scratched a 25×"): k10 / 10 from core */
export const TIER_MULTIPLE: readonly string[] = TIERS.map((t) =>
  t.k10 % 10n === 0n ? String(t.k10 / 10n) : `${t.k10 / 10n}.${t.k10 % 10n}`,
)

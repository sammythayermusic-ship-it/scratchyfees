/**
 * Classify a failed simulation / on-chain error for a token transfer.
 *  permanent — retrying can never succeed (frozen account, wrong owner/program…) → failed_permanent + alert
 *  low_gas   — the signer lacks SOL for fees/rent → pause payouts (auto-resumes when funded)
 *  low_pool  — the signer lacks PUMP → pause payouts (auto-resumes when funded)
 *  transient — anything else (blockhash, RPC, congestion) → retry with backoff, never permanent
 */
export type FailureClass = 'permanent' | 'low_gas' | 'low_pool' | 'transient'

const LOW_GAS = [
  /no record of a prior credit/i,
  /insufficient (sol|lamports)/i,
  /insufficient funds for (fee|rent)/i,
  /InsufficientFundsForRent/i,
  /InsufficientFundsForFee/i,
]
// SPL Token / Token-2022 TokenError::InsufficientFunds = 1
const LOW_POOL = [
  /Token: insufficient funds/i,
  /InsufficientFunds\b(?!For)/,
  /custom program error: 0x1(?![0-9a-f])/i,
]
// TokenError::AccountFrozen = 17 (0x11), OwnerMismatch = 4, MintMismatch = 3, NonTransferable, invalid accounts
const PERMANENT = [
  /AccountFrozen/i,
  /custom program error: 0x11(?![0-9a-f])/i,
  /custom program error: 0x4(?![0-9a-f])/i,
  /custom program error: 0x3(?![0-9a-f])/i,
  /OwnerMismatch|MintMismatch/i,
  /NonTransferable/i,
  /IllegalOwner|IncorrectProgramId|InvalidAccountData|InvalidAccountOwner/i,
]

export function classifyFailure(error: string | null, permanentHint = false): FailureClass {
  const e = error ?? ''
  if (PERMANENT.some((r) => r.test(e))) return 'permanent'
  if (LOW_GAS.some((r) => r.test(e))) return 'low_gas'
  if (LOW_POOL.some((r) => r.test(e))) return 'low_pool'
  if (permanentHint) return 'permanent'
  return 'transient'
}

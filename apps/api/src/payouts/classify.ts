/**
 * Classify a failed simulation / on-chain error for a token transfer.
 *  permanent — retrying can never succeed (frozen account, wrong owner/program…) → failed_permanent + alert
 *  low_gas   — the signer lacks SOL for fees/rent → pause payouts (auto-resumes when funded)
 *  low_pool  — the signer lacks PUMP → pause payouts (auto-resumes when funded)
 *  transient — anything else (blockhash, RPC, congestion) → retry with backoff, never permanent
 *
 * Custom error codes are only meaningful for the program that raised them, so they are decided by the
 * innermost failing program (the first `Program <id> failed:` log line): a transfer-hook, ATA or memo
 * program's `0x1` is NOT "insufficient PUMP" and must never pause the whole payout pipeline.
 */
export type FailureClass = 'permanent' | 'low_gas' | 'low_pool' | 'transient'

const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
])
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'

// runtime / program-independent wording
const LOW_GAS = [
  /no record of a prior credit/i,
  /insufficient (sol|lamports)/i,
  /insufficient funds for (fee|rent)/i,
  /InsufficientFundsForRent/i,
  /InsufficientFundsForFee/i,
]
const LOW_POOL = [/Token: insufficient funds/i, /Error: insufficient funds/i, /InsufficientFunds\b(?!For)/]
const PERMANENT = [
  /AccountFrozen|Account is frozen/i,
  /OwnerMismatch|MintMismatch|owner does not match|mint mismatch/i,
  /NonTransferable/i,
  /IllegalOwner|IncorrectProgramId|InvalidAccountData|InvalidAccountOwner/i,
]
// SPL Token / Token-2022 TokenError codes — only when a token program is the failing program
const TOKEN_LOW_POOL = [/custom program error: 0x1(?![0-9a-f])/i] // InsufficientFunds = 1
const TOKEN_PERMANENT = [/custom program error: 0x(11|4|3)(?![0-9a-f])/i] // AccountFrozen = 17, OwnerMismatch = 4, MintMismatch = 3
// SystemError::ResultWithNegativeLamports = 1 (rent / fee payer short on SOL during ATA creation)
const SYSTEM_LOW_GAS = [/custom program error: 0x1(?![0-9a-f])/i]

const FAILED_LINE = /Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: ([^|]*)/

/** innermost failing program from the logs (or from logs embedded in a rendered error string) */
export function failingProgram(
  error: string | null,
  logs: readonly string[] = [],
): { program: string; message: string } | null {
  for (const l of logs) {
    const m = FAILED_LINE.exec(l)
    if (m) return { program: m[1]!, message: m[2]!.trim() }
  }
  const m = error ? FAILED_LINE.exec(error) : null
  return m ? { program: m[1]!, message: m[2]!.trim() } : null
}

export function classifyFailure(
  error: string | null,
  permanentHint = false,
  logs: readonly string[] = [],
): FailureClass {
  const e = error ?? ''
  const text = logs.length > 0 ? `${e} | ${logs.join(' | ')}` : e
  const failing = failingProgram(error, logs)
  const known =
    failing &&
    (TOKEN_PROGRAMS.has(failing.program) ||
      failing.program === SYSTEM_PROGRAM ||
      failing.program === ATA_PROGRAM)
  // any other failing program (transfer hook, memo, compute budget…): its codes and log wording mean nothing here
  if (failing && !known) return permanentHint ? 'permanent' : 'transient'

  if (PERMANENT.some((r) => r.test(text))) return 'permanent'
  if (LOW_GAS.some((r) => r.test(text))) return 'low_gas'
  if (LOW_POOL.some((r) => r.test(text))) return 'low_pool'

  if (failing) {
    if (TOKEN_PROGRAMS.has(failing.program)) {
      if (TOKEN_PERMANENT.some((r) => r.test(failing.message))) return 'permanent'
      if (TOKEN_LOW_POOL.some((r) => r.test(failing.message))) return 'low_pool'
    } else if (failing.program === SYSTEM_PROGRAM) {
      if (SYSTEM_LOW_GAS.some((r) => r.test(failing.message))) return 'low_gas'
    } else if (failing.program === ATA_PROGRAM) {
      // AssociatedTokenAccountError::InvalidOwner = 0 — an existing account at the ATA address with another owner
      if (/custom program error: 0x0(?![0-9a-f])/i.test(failing.message)) return 'permanent'
    }
    return permanentHint ? 'permanent' : 'transient'
  }
  // a bare "instruction N: custom program error: 0x…" (e.g. an on-chain status without logs) is not attributed
  // to a program: retry — the rebuild's simulation carries logs and classifies it properly
  if (permanentHint) return 'permanent'
  return 'transient'
}

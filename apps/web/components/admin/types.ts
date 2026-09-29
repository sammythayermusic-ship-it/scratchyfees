/**
 * Shapes of GET /api/admin/status (apps/api/src/routes/admin.ts). Every bigint arrives as a decimal string
 * (routes/http.ts jsonSafe) and every Date as an ISO string.
 */

export type HardPauseReason = 'manual' | 'breaker_mismatch' | 'invariant' | 'mint_changed' | 'payouts_stuck'

export interface PauseInfo {
  reason: HardPauseReason
  note: string
  at: string
}

export interface MonitorState {
  lowGas: boolean
  lowPool: boolean
  lowPoolReason: 'no_price' | 'below_reserve' | null
  creatorGasLow: boolean
  prizeSolLamports: string | null
  prizePumpRaw: string | null
  jackpotRaw: string | null
  outstandingRaw: string | null
  poolRaw: string | null
  reserveRaw: string | null
  creatorSolLamports: string | null
  checkedAt: string | null
  lastError: string | null
}

export type PriceState = 'fresh' | 'stale' | 'frozen' | 'none'

export interface PriceQuote {
  valueE18: string
  source: string
  at: string
}

export interface OracleSnapshot {
  pumpUsd: PriceQuote | null
  scratchyPump: PriceQuote | null
  scratchyUsd: PriceQuote | null
  state: PriceState
  lastFreshAt: string | null
}

export interface PayoutRateInfo {
  /** decimal strings, e.g. "0.005" */
  effective: string
  default: string
  min: string
  max: string
  appliesFrom: string
}

export type PayoutStatus = 'queued' | 'held' | 'sending' | 'confirmed' | 'failed' | 'failed_permanent'

export interface AdminPayout {
  id: string
  /** tier | jackpot | sweep_prize | sweep_ops */
  kind: string
  signer: string
  sweepId: string | null
  wallet: string
  amountRaw: string
  roundId: number
  status: PayoutStatus
  heldReason: string | null
  txSig: string | null
  landedSlot: string | null
  ataCreated: boolean | null
  rebuilds: number
  simFailures: number
  nextAttemptAt: string | null
  leaseOwner: string | null
  leaseExpiresAt: string | null
  error: string | null
  pumpUsdE18: string | null
  createdAt: string
  sentAt: string | null
  confirmedAt: string | null
}

export type Severity = 'info' | 'warn' | 'critical'

export interface AdminEvent {
  id: string
  kind: string
  severity: Severity
  message: string
  data: unknown
  at: string
}

export interface AdminSweep {
  id: string
  /** claimed | swapped | split | done | failed */
  status: string
  claimedPumpRaw: string
  claimedScratchyRaw: string
  swapInScratchyRaw: string
  swapOutPumpRaw: string
  totalPumpRaw: string
  toPrizeRaw: string
  toOpsRaw: string
  txSigs: string[]
  creatorScratchyBaselineRaw: string | null
  swapSig: string | null
  swapLastValidBlockHeight: string | null
  swapIntentInRaw: string | null
  error: string | null
  at: string
  updatedAt: string
}

export interface AdminRound {
  id: number
  startsAt: string
  endsAt: string
  /** pending | live | ended | skipped */
  status: string
  skipReason: string | null
  serverSeedHash: string
  serverSeed: string | null
  walletBalanceRaw: string | null
  outstandingRaw: string | null
  snapshotSlot: string | null
  poolRaw: string | null
  budgetRaw: string | null
  ticketBudgetRaw: string | null
  jackpotAccrualRaw: string | null
  jackpotAfterRaw: string | null
  singlePrizeCapRaw: string | null
  breakerLimitRaw: string | null
  payoutRatePpm: string | null
  jackpotSharePpm: string | null
  singlePrizeCapPpm: string | null
  roundBreakerPpm: string | null
  jackpotOdds: string | null
  totalWeightedMicro: string | null
  entrantCount: number
  ticketCount: number
  pumpUsdE18: string | null
  scratchyUsdE18: string | null
  priceState: string | null
  realizedRaw: string
  breakerTripped: boolean
  /** null | ok | mismatch */
  breakerVerified: string | null
  createdAt: string
}

export interface AdminStatus {
  pauses: PauseInfo[]
  monitor: MonitorState
  oracle: OracleSnapshot
  payoutRate: PayoutRateInfo
  queue: { queued: number; sending: number } | undefined
  problemPayouts: AdminPayout[]
  events: AdminEvent[]
  sweeps: AdminSweep[]
  rounds: AdminRound[]
  wallets: { prize: string; creator: string | null; ops: string | null }
  cluster: string
}

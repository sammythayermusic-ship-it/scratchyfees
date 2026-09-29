/** Shapes returned by apps/api (bigints arrive as decimal strings). */
export type SymbolKey =
  'coin' | 'bag' | 'bar' | 'diamond' | 'crown' | 'seven' | 'clover' | 'star' | 'scratchy'
export type TierId = 0 | 1 | 2 | 3 | 4 | 5

export interface RoundSnapshot {
  serverTime: string
  roundSeconds: number
  round: {
    id: number
    status: 'live' | 'ended' | 'skipped' | 'pending'
    startsAt: string
    endsAt: string
    seedHash: string
    skipReason: string | null
    entrants: number
    tickets: number
    poolRaw: string | null
    budgetRaw: string | null
    totalWeightedMicro: string | null
  } | null
  nextRound: { id: number; startsAt: string; seedHash: string } | null
  pool: { raw: string; jackpotRaw: string; decimals: number }
  prices: {
    pumpUsdE18: string | null
    scratchyUsdE18: string | null
    state: 'fresh' | 'stale' | 'frozen' | 'none'
    lastFreshAt: string | null
  }
  paused: string | null
  cluster: string
  you: { entered: boolean; ticketsRemaining: number } | null
}

export interface TicketOutcome {
  ticketId: string
  roundId: number
  idx: number
  tier: TierId
  jackpot: boolean
  prizeRaw: string
  jackpotPrizeRaw: string
  symbols: [SymbolKey, SymbolKey, SymbolKey]
  payoutId: string | null
  jackpotPayoutId: string | null
  held: boolean
}

export interface TicketView {
  id: string
  idx: number
  scratched: boolean
  void: boolean
  outcome: TicketOutcome | null
}

export interface EnterResult {
  wallet: string
  xHandle: string | null
  eligibleNow: boolean
  holdingsRaw: string
  holdingsUsdMicro: string
  ticketsPerDrop: number
  multMicro: string
  nudge: { extraUsd: string; extraTickets: string; multGainMicro: string; maxed: boolean }
  round: { id: number; startsAt: string; endsAt: string } | null
  entry: { tickets: TicketView[]; voided: string | null; multMicro: string } | null
  locked: boolean
  nextDropAt: string
  priceState: string
}

export interface ScratchResponse {
  ok: true
  roundId: number
  wallet: string
  outcomes: TicketOutcome[]
}

export interface PayoutView {
  id: string
  kind: 'tier' | 'jackpot'
  wallet: string
  amountRaw: string
  status: 'queued' | 'held' | 'sending' | 'confirmed' | 'failed' | 'failed_permanent'
  held: boolean
  txSig: string | null
  roundId: number
  pumpUsdE18: string | null
}

export interface WinnerRow {
  ticketId: string
  roundId: number
  wallet: string
  xHandle: string | null
  tier: TierId
  multMicro: string | null
  prizeRaw: string
  jackpotPrizeRaw: string
  at: string
  txSig: string | null
  payoutStatus: string | null
  pumpUsdE18: string | null
}

export type LiveEvent =
  | ({ type: 'snapshot' } & RoundSnapshot)
  | {
      type: 'tick'
      serverTime: string
      pool: RoundSnapshot['pool']
      prices: RoundSnapshot['prices']
      paused: string | null
      round: RoundSnapshot['round']
    }
  | {
      type: 'drop'
      roundId: number
      startsAt: string
      endsAt: string
      seedHash: string
      nextSeedHash: string | null
      entrants: number
      tickets: number
      poolRaw: string
      jackpotRaw: string
      skipped: string | null
    }
  | { type: 'round_end'; roundId: number; serverSeed: string }
  | {
      type: 'winner'
      roundId: number
      ticketId: string
      wallet: string
      xHandle: string | null
      tier: TierId
      /** the winner's multiplier that round (micro-units, 1_000_000 = 1×) */
      multMicro: string
      prizeRaw: string
      jackpot: boolean
      jackpotPrizeRaw: string
      payoutId: string | null
      pumpUsdE18: string | null
      at: string
    }
  | {
      type: 'jackpot'
      roundId: number
      wallet: string
      xHandle: string | null
      amountRaw: string
      pumpUsdE18: string | null
      at: string
    }
  | {
      type: 'payout'
      payoutId: string
      wallet: string
      kind: string
      status: string
      amountRaw: string
      txSig: string | null
    }
  | { type: 'void'; roundId: number; wallet: string; reason: string }

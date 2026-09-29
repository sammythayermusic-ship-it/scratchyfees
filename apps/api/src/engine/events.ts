/**
 * In-process event bus: the round engine, scratch service and payout worker publish; the websocket feed
 * (and Telegram digests) subscribe. Payloads are already JSON-safe (bigints as decimal strings) so every
 * consumer can forward them as-is.
 */

export interface DropEvent {
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

export interface RoundEndEvent {
  type: 'round_end'
  roundId: number
  serverSeed: string
}

export interface WinnerEvent {
  type: 'winner'
  roundId: number
  wallet: string
  xHandle: string | null
  tier: number
  multMicro: string
  prizeRaw: string
  jackpot: boolean
  jackpotPrizeRaw: string
  payoutId: string | null
  pumpUsdE18: string | null
  at: string
}

export interface JackpotEvent {
  type: 'jackpot'
  roundId: number
  wallet: string
  xHandle: string | null
  amountRaw: string
  pumpUsdE18: string | null
  at: string
}

export interface PayoutStatusEvent {
  type: 'payout'
  payoutId: string
  wallet: string
  kind: string
  status: string
  amountRaw: string
  txSig: string | null
}

export interface VoidEvent {
  type: 'void'
  roundId: number
  wallet: string
  reason: string
}

export type EngineEvent =
  DropEvent | RoundEndEvent | WinnerEvent | JackpotEvent | PayoutStatusEvent | VoidEvent

export class EventBus {
  private readonly listeners = new Set<(e: EngineEvent) => void>()

  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(e: EngineEvent): void {
    for (const l of this.listeners) {
      try {
        l(e)
      } catch {
        /* a broken subscriber never breaks the engine */
      }
    }
  }
}

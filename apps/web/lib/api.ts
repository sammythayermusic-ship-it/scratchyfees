import { API_ORIGIN } from './config'
import { sessionId } from './session'
import type { EnterResult, PayoutView, RoundSnapshot, ScratchResponse, WinnerRow } from './types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-scratchy-session': sessionId(),
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
  if (!res.ok)
    throw new ApiError(res.status, body.error ?? 'error', body.message ?? `request failed (${res.status})`)
  return body as T
}

export const api = {
  round: (wallet?: string | null) =>
    call<RoundSnapshot>(`/api/round${wallet ? `?wallet=${encodeURIComponent(wallet)}` : ''}`),
  enter: (wallet: string, xHandle?: string | null) =>
    call<EnterResult>('/api/enter', {
      method: 'POST',
      body: JSON.stringify({ wallet, x_handle: xHandle || undefined }),
    }),
  scratch: (ticketIds: string[], wallet: string) =>
    call<ScratchResponse>('/api/scratch', {
      method: 'POST',
      body: JSON.stringify({ ticket_ids: ticketIds, wallet }),
    }),
  payout: (id: string) => call<PayoutView>(`/api/payout/${id}`),
  winners: (before?: string) =>
    call<{ recent: WinnerRow[]; biggest: WinnerRow[]; nextBefore: string | null }>(
      `/api/winners${before ? `?before=${before}` : ''}`,
    ),
  stats: () =>
    call<{
      totalPaidRaw: string
      payoutCount: number
      biggestWinRaw: string
      sweptToPoolRaw: string
      sweptToOpsRaw: string
      poolHistory: {
        id: number
        startsAt: string
        status: string
        poolRaw: string | null
        jackpotRaw: string | null
        tickets: number
      }[]
    }>('/api/stats'),
  fair: (roundId: number) => call<FairRound>(`/api/fair/${roundId}`),
  fairTickets: (roundId: number, wallet: string) =>
    call<{
      roundId: number
      wallet: string
      tickets: {
        idx: number
        tier: number
        jackpot: boolean
        prizeRaw: string
        scratched: string | null
        void: boolean
      }[]
    }>(`/api/fair/${roundId}/tickets?wallet=${encodeURIComponent(wallet)}`),
  admin: <T>(path: string, token: string, init: RequestInit = {}) =>
    call<T>(`/api/admin${path}`, { ...init, headers: { authorization: `Bearer ${token}` } }),
}

export interface FairRound {
  round: {
    id: number
    status: string
    startsAt: string
    endsAt: string
    seedHash: string
    serverSeed: string | null
    poolRaw: string | null
    budgetRaw: string | null
    ticketBudgetRaw: string | null
    jackpotAccrualRaw: string | null
    singlePrizeCapRaw: string | null
    payoutRatePpm: string | null
    jackpotSharePpm: string | null
    singlePrizeCapPpm: string | null
    roundBreakerPpm: string | null
    jackpotOdds: string | null
    totalWeightedMicro: string | null
    skipReason: string | null
  }
  entries: { wallet: string; tickets: number; multMicro: string; holdingsUsdMicro: string }[]
  howToVerify: string[]
}

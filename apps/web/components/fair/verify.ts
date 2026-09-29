import {
  budgetFromParams,
  CUMULATIVE_PPM,
  deriveTicket,
  recomputeTicket,
  scaledToDecimal,
  seedCommitment,
  seedFromHex,
  seedMatchesCommitment,
  ticketDigest,
  ticketMessage,
  tierPrizeRaw,
  TIERS,
  totalWeightMicro,
  uniform53At,
  type RecomputedTicket,
  type RoundBudget,
  type RoundParams,
  type TierId,
} from '@scratchy/core'
import type { FairRound } from '../../lib/api'
import { PUMP_DECIMALS } from '../../lib/config'

/**
 * Pure glue between the /api/fair responses and @scratchy/core. Every number that decides an outcome or a
 * prize comes from a core function (recomputeTicket, budgetFromParams, seedMatchesCommitment, …) — the
 * exact same code the server ran when it issued the tickets. Nothing here re-derives the math.
 */

export type FairRoundData = FairRound['round']
export type FairEntry = FairRound['entries'][number]

export interface StoredTicket {
  idx: number
  tier: number
  jackpot: boolean
  prizeRaw: string
  scratched: string | null
  void: boolean
}

/** The API publishes at most this many entries per round (apps/api/src/routes/public.ts). */
export const ENTRY_LIST_LIMIT = 5_000
/** Round-wide sample: verify about this many tickets per page. */
export const SAMPLE_PAGE_TICKETS = 100
/** …but never fetch more than this many wallets in one page. */
export const SAMPLE_PAGE_MAX_WALLETS = 25

export const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

// ── inputs ───────────────────────────────────────────────────────────────────

/** "12", "#12", " 12 " → 12. Anything else → null. */
export function parseRoundInput(s: string | null | undefined): number | null {
  const t = (s ?? '').trim().replace(/^#/, '')
  if (!/^\d{1,9}$/.test(t)) return null
  const n = Number(t)
  return n > 0 ? n : null
}

/** "" → null (not given), "7" / "#7" → 7, anything else → 'invalid'. */
export function parseTicketInput(s: string | null | undefined): number | null | 'invalid' {
  const t = (s ?? '').trim().replace(/^#/, '')
  if (t === '') return null
  if (!/^\d{1,6}$/.test(t)) return 'invalid'
  return Number(t)
}

// ── round parameters ─────────────────────────────────────────────────────────

const REQUIRED_PARAMS = [
  'poolRaw',
  'payoutRatePpm',
  'jackpotSharePpm',
  'singlePrizeCapPpm',
  'jackpotOdds',
  'totalWeightedMicro',
] as const

export type ParamsResult = { ok: true; params: RoundParams } | { ok: false; missing: string[] }

/**
 * The round's OWN stored parameters as core's RoundParams (the same shape the server's breaker
 * auto-verification uses). Missing values are reported, never defaulted — a verifier must not guess.
 */
export function roundParamsFromApi(r: FairRoundData): ParamsResult {
  const missing = REQUIRED_PARAMS.filter((k) => r[k] === null || r[k] === undefined)
  if (missing.length > 0) return { ok: false, missing: [...missing] }
  return {
    ok: true,
    params: {
      roundId: r.id,
      poolRaw: BigInt(r.poolRaw!),
      payoutRatePpm: BigInt(r.payoutRatePpm!),
      jackpotSharePpm: BigInt(r.jackpotSharePpm!),
      singlePrizeCapPpm: BigInt(r.singlePrizeCapPpm!),
      // not used by prize math, only by the payout breaker
      roundBreakerPpm: BigInt(r.roundBreakerPpm ?? '0'),
      jackpotOdds: BigInt(r.jackpotOdds!),
      totalWeightMicro: BigInt(r.totalWeightedMicro!),
    },
  }
}

// ── seed commitment ──────────────────────────────────────────────────────────

export interface SeedCheck {
  status: 'match' | 'mismatch' | 'malformed'
  /** sha256(serverSeed) computed in this browser */
  computedHash: string | null
}

export function checkSeed(seedHex: string, commitmentHex: string): SeedCheck {
  try {
    const ok = seedMatchesCommitment(seedHex, commitmentHex)
    return { status: ok ? 'match' : 'mismatch', computedHash: seedCommitment(seedFromHex(seedHex)) }
  } catch {
    return { status: 'malformed', computedHash: null }
  }
}

// ── round math consistency (stored budget vs recomputed from P and the stored rates) ──────────────

export type CheckStatus = 'match' | 'mismatch' | 'unavailable'

export interface ValueCheck {
  key: 'budget' | 'jackpotAccrual' | 'ticketBudget' | 'singlePrizeCap' | 'totalWeight'
  label: string
  stored: bigint | null
  recomputed: bigint | null
  status: CheckStatus
  note?: string
}

const big = (v: string | null | undefined): bigint | null =>
  v === null || v === undefined ? null : BigInt(v)

function valueCheck(
  key: ValueCheck['key'],
  label: string,
  stored: bigint | null,
  recomputed: bigint | null,
  note?: string,
): ValueCheck {
  const status: CheckStatus =
    stored === null || recomputed === null ? 'unavailable' : stored === recomputed ? 'match' : 'mismatch'
  return { key, label, stored, recomputed, status, ...(note ? { note } : {}) }
}

/** Σ tickets × mult over the published entries, summed by core's totalWeightMicro. */
export function publishedWeightMicro(entries: readonly FairEntry[]): bigint {
  return totalWeightMicro(entries.map((e) => ({ weightMicro: BigInt(e.tickets) * BigInt(e.multMicro) })))
}

export function checkRoundMath(
  r: FairRoundData,
  params: RoundParams,
  entries: readonly FairEntry[],
): ValueCheck[] {
  const b = budgetFromParams(params)
  const complete = entries.length < ENTRY_LIST_LIMIT
  return [
    valueCheck('budget', 'B = P × payout rate', big(r.budgetRaw), b.budgetRaw),
    valueCheck('jackpotAccrual', 'Jackpot share of B', big(r.jackpotAccrualRaw), b.jackpotAccrualRaw),
    valueCheck(
      'ticketBudget',
      'Ticket budget = B − jackpot share',
      big(r.ticketBudgetRaw),
      b.ticketBudgetRaw,
    ),
    valueCheck(
      'singlePrizeCap',
      'Single-prize cap = P × cap rate',
      big(r.singlePrizeCapRaw),
      b.singlePrizeCapRaw,
    ),
    valueCheck(
      'totalWeight',
      'W = Σ tickets × mult (published entries)',
      params.totalWeightMicro,
      complete ? publishedWeightMicro(entries) : null,
      complete ? undefined : `entry list truncated at ${ENTRY_LIST_LIMIT.toLocaleString('en-US')}`,
    ),
  ]
}

// ── tickets ──────────────────────────────────────────────────────────────────

export interface TicketRow {
  wallet: string
  idx: number
  multMicro: bigint
  recomputed: RecomputedTicket
  /** what the server recorded; null → the server returned no record for this ticket index */
  stored: StoredTicket | null
  tierOk: boolean
  jackpotOk: boolean
  prizeOk: boolean
  match: boolean
}

export function compareTicket(
  seedHex: string,
  params: RoundParams,
  wallet: string,
  idx: number,
  multMicro: bigint,
  stored: StoredTicket | null,
): TicketRow {
  const recomputed = recomputeTicket(seedHex, wallet, idx, multMicro, params)
  const tierOk = stored !== null && stored.tier === recomputed.tier
  const jackpotOk = stored !== null && stored.jackpot === recomputed.jackpot
  const prizeOk = stored !== null && BigInt(stored.prizeRaw) === recomputed.prizeRaw
  return {
    wallet,
    idx,
    multMicro,
    recomputed,
    stored,
    tierOk,
    jackpotOk,
    prizeOk,
    match: tierOk && jackpotOk && prizeOk,
  }
}

export interface WalletVerification {
  rows: TicketRow[]
  /** human-readable problems that aren't a single ticket's outcome (e.g. missing tickets) */
  issues: string[]
}

/**
 * Recompute every ticket of one wallet's entry and compare with the server's records. Tickets the entry
 * says exist but the server didn't return show up as mismatches, and so does any extra ticket.
 */
export function verifyWalletTickets(
  seedHex: string,
  params: RoundParams,
  entry: Pick<FairEntry, 'wallet' | 'tickets' | 'multMicro'>,
  stored: readonly StoredTicket[],
  onlyIdx: number | null = null,
): WalletVerification {
  const multMicro = BigInt(entry.multMicro)
  const byIdx = new Map(stored.map((t) => [t.idx, t]))
  const issues: string[] = []
  if (onlyIdx !== null) {
    if (onlyIdx >= entry.tickets && !byIdx.has(onlyIdx)) {
      issues.push(`ticket #${onlyIdx} doesn't exist — this entry has tickets #0–#${entry.tickets - 1}`)
      return { rows: [], issues }
    }
    const row = compareTicket(seedHex, params, entry.wallet, onlyIdx, multMicro, byIdx.get(onlyIdx) ?? null)
    return { rows: [row], issues }
  }
  const idxs = new Set<number>(stored.map((t) => t.idx))
  for (let i = 0; i < entry.tickets; i++) idxs.add(i)
  const rows = [...idxs]
    .sort((a, b) => a - b)
    .map((i) => compareTicket(seedHex, params, entry.wallet, i, multMicro, byIdx.get(i) ?? null))
  if (stored.length !== entry.tickets) {
    issues.push(
      `the entry for ${entry.wallet} lists ${entry.tickets} ticket${entry.tickets === 1 ? '' : 's'} but the server returned ${stored.length}`,
    )
  }
  return { rows, issues }
}

export interface TicketSummary {
  total: number
  matched: number
  mismatched: number
  wins: number
  jackpots: number
  totalPrizeRaw: bigint
}

export function summarize(rows: readonly TicketRow[]): TicketSummary {
  let matched = 0
  let wins = 0
  let jackpots = 0
  let totalPrizeRaw = 0n
  for (const r of rows) {
    if (r.match) matched++
    if (r.recomputed.prizeRaw > 0n) wins++
    if (r.recomputed.jackpot) jackpots++
    totalPrizeRaw += r.recomputed.prizeRaw
  }
  return { total: rows.length, matched, mismatched: rows.length - matched, wins, jackpots, totalPrizeRaw }
}

/**
 * The next page of the round-wide sample: consecutive entries from `start` until ~SAMPLE_PAGE_TICKETS
 * tickets (always at least one wallet, at most SAMPLE_PAGE_MAX_WALLETS).
 */
export function planSamplePage(
  entries: readonly FairEntry[],
  start: number,
  targetTickets = SAMPLE_PAGE_TICKETS,
  maxWallets = SAMPLE_PAGE_MAX_WALLETS,
): { wallets: FairEntry[]; next: number | null } {
  const wallets: FairEntry[] = []
  let tickets = 0
  let i = start
  while (
    i < entries.length &&
    wallets.length < maxWallets &&
    (wallets.length === 0 || tickets < targetTickets)
  ) {
    const e = entries[i]!
    wallets.push(e)
    tickets += e.tickets
    i++
  }
  return { wallets, next: i < entries.length ? i : null }
}

// ── default round ────────────────────────────────────────────────────────────

export interface RoundHistoryRow {
  id: number
  status: string
  tickets: number
}

/** Most recent ended rounds (newest first), for the quick-pick chips. */
export function recentEndedRounds(history: readonly RoundHistoryRow[], n = 6): RoundHistoryRow[] {
  return history
    .filter((r) => r.status === 'ended')
    .sort((a, b) => b.id - a.id)
    .slice(0, n)
}

/**
 * Default round for the form: the latest ended round that issued tickets, else the latest ended round,
 * else the one before the live round (from /api/round).
 */
export function pickDefaultRound(
  history: readonly RoundHistoryRow[] | null,
  current: { id: number; status: string } | null,
): number | null {
  const ended = recentEndedRounds(history ?? [], Number.MAX_SAFE_INTEGER)
  const withTickets = ended.find((r) => r.tickets > 0)
  if (withTickets) return withTickets.id
  if (ended[0]) return ended[0].id
  if (!current) return null
  if (current.status === 'ended') return current.id
  return current.id > 1 ? current.id - 1 : null
}

// ── per-ticket proof ("show your work") ──────────────────────────────────────

/** Large enough that core's min(prize, cap) never bites — gives the pre-cap value for display. */
const NO_CAP = 1n << 255n

export interface TicketProof {
  message: string
  digestHex: string
  /** bytes 0–7 and 8–15 of the digest, hex */
  bytesTier: string
  bytesJackpot: string
  x: bigint
  y: bigint
  u: number
  uJackpot: number
  tier: TierId
  /** the odds-table bucket u landed in: [lowerPpm, upperPpm) */
  lowerPpm: bigint
  upperPpm: bigint
  jackpot: boolean
  jackpotOdds: bigint
  k10: bigint
  budget: RoundBudget
  uncappedPrizeRaw: bigint
  prizeRaw: bigint
  capped: boolean
}

export function ticketProof(
  seedHex: string,
  params: RoundParams,
  wallet: string,
  idx: number,
  multMicro: bigint,
): TicketProof {
  const seed = seedFromHex(seedHex)
  const digest = ticketDigest(seed, wallet, params.roundId, idx)
  const d = deriveTicket(seed, wallet, params.roundId, idx, params.jackpotOdds)
  const rc = recomputeTicket(seedHex, wallet, idx, multMicro, params)
  const budget = budgetFromParams(params)
  const k10 = TIERS[d.tier]!.k10
  const uncappedPrizeRaw = tierPrizeRaw(
    k10,
    { ticketBudgetRaw: budget.ticketBudgetRaw, singlePrizeCapRaw: NO_CAP },
    multMicro,
    params.totalWeightMicro,
  )
  return {
    message: ticketMessage(wallet, params.roundId, idx),
    digestHex: d.digestHex,
    bytesTier: d.digestHex.slice(0, 16),
    bytesJackpot: d.digestHex.slice(16, 32),
    x: uniform53At(digest, 0),
    y: uniform53At(digest, 8),
    u: d.u,
    uJackpot: d.uJackpot,
    tier: d.tier,
    lowerPpm: d.tier === 0 ? 0n : CUMULATIVE_PPM[d.tier - 1]!,
    upperPpm: CUMULATIVE_PPM[d.tier]!,
    jackpot: d.jackpot,
    jackpotOdds: params.jackpotOdds,
    k10,
    budget,
    uncappedPrizeRaw,
    prizeRaw: rc.prizeRaw,
    capped: rc.prizeRaw < uncappedPrizeRaw,
  }
}

// ── display ──────────────────────────────────────────────────────────────────

const groupInt = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** Exact PUMP amount, every decimal kept: 17813923n → "17.813923", 262488073605n → "262,488.073605". */
export function pumpExact(raw: bigint | string): string {
  const s = scaledToDecimal(BigInt(raw), PUMP_DECIMALS)
  const [int = '0', frac] = s.split('.')
  return frac ? `${groupInt(int)}.${frac}` : groupInt(int)
}

/** 5000n ppm → "0.5%", 100000n → "10%". */
export function ppmPercent(ppm: bigint | string): string {
  return `${scaledToDecimal(BigInt(ppm), 4)}%`
}

/** 1439893n → "1.439893×" */
export function multExact(micro: bigint | string): string {
  return `${scaledToDecimal(BigInt(micro), 6)}×`
}

/** 700000n → "0.7" */
export function ppmFraction(ppm: bigint): string {
  return scaledToDecimal(ppm, 6)
}

export function groupBig(v: bigint | string): string {
  return groupInt(BigInt(v).toString())
}

// ── offline reproduction ─────────────────────────────────────────────────────

export interface PythonCheckInput {
  roundId: number | string
  serverSeed: string
  seedHash: string
  poolRaw: string
  payoutRatePpm: string
  jackpotSharePpm: string
  singlePrizeCapPpm: string
  jackpotOdds: string
  totalWeightedMicro: string
  /** wallet → [ticket count, multiplier in micro-units] */
  entries: { wallet: string; tickets: number; multMicro: string }[]
}

/**
 * A self-contained Python 3 script (stdlib only: hmac + hashlib) that re-derives the round without any of
 * our code. The odds table and prize constants are emitted from core's TIERS so they can never drift.
 */
export function pythonCheck(input: PythonCheckInput | null): string {
  const v = (s: string | number | undefined, placeholder: string) => (input ? String(s) : placeholder)
  const cum = CUMULATIVE_PPM.map((c) => c.toString()).join(', ')
  const k10 = TIERS.map((t) => t.k10.toString()).join(', ')
  const names = TIERS.map((t) => `"${t.key}"`).join(', ')
  const entries = input
    ? input.entries.map((e) => `    "${e.wallet}": (${e.tickets}, ${e.multMicro}),`).join('\n')
    : '    "<wallet>": (<tickets>, <multMicro>),'
  return `# $SCRATCHY round check — Python 3 standard library only (hmac + hashlib)
import hashlib, hmac

ROUND_ID = ${v(input?.roundId, '<roundId>')}
SERVER_SEED = "${v(input?.serverSeed, '<serverSeed hex>')}"
SEED_HASH = "${v(input?.seedHash, '<seedHash hex>')}"
P = ${v(input?.poolRaw, '<poolRaw>')}                      # pool snapshot, raw PUMP (6 decimals)
PAYOUT_RATE_PPM = ${v(input?.payoutRatePpm, '<payoutRatePpm>')}
JACKPOT_SHARE_PPM = ${v(input?.jackpotSharePpm, '<jackpotSharePpm>')}
SINGLE_PRIZE_CAP_PPM = ${v(input?.singlePrizeCapPpm, '<singlePrizeCapPpm>')}
JACKPOT_ODDS = ${v(input?.jackpotOdds, '<jackpotOdds>')}
W = ${v(input?.totalWeightedMicro, '<totalWeightedMicro>')}                      # Σ tickets × mult, micro-units
ENTRIES = {  # wallet: (tickets, multMicro)
${entries}
}

CUM = [${cum}]   # cumulative odds, ppm
K10 = [${k10}]   # prize in tenths of e
NAMES = [${names}]

seed = bytes.fromhex(SERVER_SEED)
assert hashlib.sha256(seed).hexdigest() == SEED_HASH, "seed does not match the commitment"
B = P * PAYOUT_RATE_PPM // 1_000_000
ticket_budget = B - B * JACKPOT_SHARE_PPM // 1_000_000
cap = P * SINGLE_PRIZE_CAP_PPM // 1_000_000

for wallet, (tickets, mult) in ENTRIES.items():
    for idx in range(tickets):
        d = hmac.new(seed, f"{wallet}:{ROUND_ID}:{idx}".encode(), hashlib.sha256).digest()
        x = int.from_bytes(d[0:8], "big") >> 11
        y = int.from_bytes(d[8:16], "big") >> 11
        tier = next(i for i, c in enumerate(CUM) if x * 1_000_000 < c * 2**53)
        jackpot = y * JACKPOT_ODDS < 2**53
        prize = min(K10[tier] * ticket_budget * mult // (10 * W), cap) if W else 0
        print(wallet, idx, NAMES[tier], "JACKPOT" if jackpot else "-", prize)
`
}

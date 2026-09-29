import type { RoundParams } from '@scratchy/core'
import { api, type FairRound } from '@/lib/api'
import {
  checkRoundMath,
  checkSeed,
  ENTRY_LIST_LIMIT,
  planSamplePage,
  roundParamsFromApi,
  verifyWalletTickets,
  type FairEntry,
  type FairRoundData,
  type SeedCheck,
  type TicketRow,
  type ValueCheck,
} from './verify'

/** Fetch the public round + tickets and run every check through core (see ./verify). */

export interface Query {
  roundId: number
  /** null → spot-check the whole round page by page */
  wallet: string | null
  ticketIdx: number | null
}

export interface Report {
  query: Query
  fair: FairRound
  seed: string
  seedCheck: SeedCheck
  params: RoundParams | null
  missingParams: string[]
  mathChecks: ValueCheck[]
  mode: 'wallet' | 'sample'
  /** wallet mode: that wallet's published entry (null → it didn't enter this round) */
  entry: FairEntry | null
  rows: TicketRow[]
  issues: string[]
  /** entries whose tickets have been checked so far (for the offline script) */
  checkedEntries: FairEntry[]
  /** sample mode: index of the next entry to check (null → every wallet checked) */
  nextCursor: number | null
}

/** A well-formed request that can't be answered (e.g. a ticket # past the entry) — shown as a plain message. */
export class FairInputError extends Error {}

export type Loaded =
  { kind: 'unrevealed'; query: Query; round: FairRoundData } | { kind: 'report'; report: Report }

const FETCH_CONCURRENCY = 5

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))))
  }
  return out
}

/** Verify the tickets of the given entries (one /tickets call per wallet). */
async function verifyEntries(
  roundId: number,
  seed: string,
  params: RoundParams,
  entries: readonly FairEntry[],
  onlyIdx: number | null,
): Promise<{ rows: TicketRow[]; issues: string[] }> {
  const results = await mapLimited(entries, FETCH_CONCURRENCY, async (entry) => {
    const stored = await api.fairTickets(roundId, entry.wallet)
    return verifyWalletTickets(seed, params, entry, stored.tickets, onlyIdx)
  })
  return { rows: results.flatMap((r) => r.rows), issues: results.flatMap((r) => r.issues) }
}

export async function loadReport(query: Query): Promise<Loaded> {
  const fair = await api.fair(query.roundId)
  const r = fair.round
  if (!r.serverSeed) return { kind: 'unrevealed', query, round: r }

  const seed = r.serverSeed
  const seedCheck = checkSeed(seed, r.seedHash)
  const pr = roundParamsFromApi(r)
  const report: Report = {
    query,
    fair,
    seed,
    seedCheck,
    params: pr.ok ? pr.params : null,
    missingParams: pr.ok ? [] : pr.missing,
    mathChecks: pr.ok ? checkRoundMath(r, pr.params, fair.entries) : [],
    mode: query.wallet ? 'wallet' : 'sample',
    entry: null,
    rows: [],
    issues: [],
    checkedEntries: [],
    nextCursor: null,
  }
  // a skipped round issued no tickets (its seed is still revealed so the commitment can be checked)
  if (!pr.ok || r.status !== 'ended' || seedCheck.status === 'malformed') return { kind: 'report', report }

  if (query.wallet) {
    const entry = fair.entries.find((e) => e.wallet === query.wallet) ?? null
    report.entry = entry
    if (!entry) {
      if (fair.entries.length >= ENTRY_LIST_LIMIT) {
        throw new FairInputError(
          `Round #${query.roundId} has more than ${ENTRY_LIST_LIMIT.toLocaleString('en-US')} entries and this wallet isn't in the published list, so its multiplier can't be looked up here. Use the raw API or the offline script instead.`,
        )
      }
      return { kind: 'report', report }
    }
    const v = await verifyEntries(query.roundId, seed, pr.params, [entry], query.ticketIdx)
    if (query.ticketIdx !== null && v.rows.length === 0) {
      throw new FairInputError(
        `Ticket #${query.ticketIdx} doesn't exist — this wallet had ${entry.tickets} ticket${entry.tickets === 1 ? '' : 's'} in round #${query.roundId} (#0–#${entry.tickets - 1}).`,
      )
    }
    report.rows = v.rows
    report.issues = v.issues
    report.checkedEntries = [entry]
    return { kind: 'report', report }
  }

  return { kind: 'report', report: await loadNextSample(report) }
}

/** Sample mode: verify the next ~100 tickets' worth of wallets and append them to the report. */
export async function loadNextSample(report: Report): Promise<Report> {
  if (!report.params) return report
  const start = report.checkedEntries.length
  const page = planSamplePage(report.fair.entries, start)
  if (page.wallets.length === 0) return { ...report, nextCursor: null }
  const v = await verifyEntries(report.query.roundId, report.seed, report.params, page.wallets, null)
  return {
    ...report,
    rows: [...report.rows, ...v.rows],
    issues: [...report.issues, ...v.issues],
    checkedEntries: [...report.checkedEntries, ...page.wallets],
    nextCursor: page.next,
  }
}

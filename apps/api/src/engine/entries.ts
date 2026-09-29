import { entryTerms, holdingsUsdMicro, holdMoreNudge, isEligible, type EconomyConfig } from '@scratchy/core'
import { and, asc, eq, sql } from 'drizzle-orm'
import { normalizeWalletAddress } from '../chain/address'
import type { ChainClient } from '../chain/types'
import type { Db } from '../db/client'
import { activity, entries, rounds, tickets, wallets } from '../db/schema'
import type { PriceOracle } from '../oracle/types'
import type { TicketOutcome } from './scratch'

/**
 * POST /api/enter + websocket heartbeats (PLAN §3.2, Decision C).
 *
 *  - Pasting a wallet (or a visible-tab heartbeat from the session that pasted it) marks it ACTIVE; wallets
 *    active during round N are entered into round N+1's drop by the round engine.
 *  - One entry per wallet per round no matter how many browsers paste it: the first session gets the
 *    scratch lock (lease renewed by heartbeats); others see "this wallet's tickets are being scratched".
 *    A lock whose holder hasn't scratched for SESSION_LOCK_SECONDS can be taken over (a stranger's idle
 *    tab can't sit on someone's tickets).
 *  - Per-IP cap on distinct wallets per round (MAX_WALLETS_PER_IP_PER_ROUND) bounds W-inflation griefing.
 */

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
  /** eligibility right now at the live price (the drop uses the snapshot at round start) */
  eligibleNow: boolean
  holdingsRaw: string
  holdingsUsdMicro: string
  ticketsPerDrop: number
  multMicro: string
  nudge: { extraUsd: string; extraTickets: string; multGainMicro: string; maxed: boolean }
  round: { id: number; startsAt: string; endsAt: string } | null
  /** this wallet's tickets in the live round, if it was entered */
  entry: { tickets: TicketView[]; voided: string | null; multMicro: string } | null
  /** another session holds the scratch lock */
  locked: boolean
  nextDropAt: string
  priceState: string
}

export type EnterError =
  | { error: 'invalid_wallet'; message: string }
  | { error: 'excluded_wallet'; message: string }
  | { error: 'too_many_wallets'; message: string }

export interface EntryDeps {
  db: Db
  chain: ChainClient
  oracle: PriceOracle
  economy: EconomyConfig
  scratchyMint: string
  excludedWallets: Set<string>
  maxWalletsPerIpPerRound: number
  sessionLockSeconds: number
  /** memory mode: dev faucet so any pasted wallet has holdings */
  beforeEnter?: (wallet: string) => Promise<void>
  /** revealed outcomes for tickets (from the scratch service) */
  outcomesFor: (rows: (typeof tickets.$inferSelect)[]) => Promise<TicketOutcome[]>
  now?: () => Date
}

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/
const ACTIVITY_WRITE_THROTTLE_MS = 30_000

export class EntryService {
  private readonly now: () => Date
  private readonly ipWallets = new Map<string, Set<string>>()
  private ipWindow = 0
  private readonly lastActivityWrite = new Map<string, number>()
  private readonly activeWindow = new Map<string, number>()
  /** wallet → session that most recently pasted it (heartbeats from that session renew activity) */
  private readonly owners = new Map<string, string>()
  private decimals: number | null = null

  constructor(private readonly d: EntryDeps) {
    this.now = d.now ?? (() => new Date())
  }

  static normalizeHandle(input: unknown): string | null {
    if (typeof input !== 'string') return null
    const h = input.trim().replace(/^@/, '')
    return HANDLE_RE.test(h) ? h : null
  }

  async enter(input: {
    wallet: unknown
    xHandle?: unknown
    sessionId: string
    ip: string
  }): Promise<EnterResult | EnterError> {
    const wallet = normalizeWalletAddress(input.wallet)
    if (!wallet) {
      return {
        error: 'invalid_wallet',
        message: 'Paste a normal Solana wallet address (not a token account or program).',
      }
    }
    if (this.d.excludedWallets.has(wallet)) {
      return {
        error: 'excluded_wallet',
        message: 'This address can’t play (it’s a pool, vault or project wallet).',
      }
    }
    const now = this.now()
    const roundMs = this.d.economy.roundSeconds * 1000
    const window = Math.floor(now.getTime() / roundMs)
    if (window !== this.ipWindow) {
      this.ipWindow = window
      this.ipWallets.clear()
    }
    const seen = this.ipWallets.get(input.ip) ?? new Set<string>()
    if (!seen.has(wallet) && seen.size >= this.d.maxWalletsPerIpPerRound) {
      return {
        error: 'too_many_wallets',
        message: 'Too many different wallets from this connection this round.',
      }
    }
    seen.add(wallet)
    this.ipWallets.set(input.ip, seen)
    this.owners.set(wallet, input.sessionId)
    // Decision C activity first: an RPC hiccup below must never cost a player the next drop (eligibility is
    // decided from the snapshot at the drop anyway, not from this preview)
    await this.markActive(wallet, now)

    await this.d.beforeEnter?.(wallet)
    const xHandle = EntryService.normalizeHandle(input.xHandle)

    // holdings preview at the live price
    const bal = await this.d.chain.getTokenBalance(wallet, this.d.scratchyMint)
    const prices = this.d.oracle.peek()
    const decimals = await this.scratchyDecimals()
    const h = prices.scratchyUsd ? holdingsUsdMicro(bal.value, decimals, prices.scratchyUsd.valueE18) : 0n
    const terms = entryTerms(h, this.d.economy)
    const nudge = holdMoreNudge(h, this.d.economy)
    const eligible = isEligible(h, this.d.economy)

    await this.d.db
      .insert(wallets)
      .values({ address: wallet, xHandle, lastActiveAt: now, eligibleSince: eligible ? now : null })
      .onConflictDoUpdate({
        target: wallets.address,
        set: {
          lastActiveAt: now,
          ...(xHandle ? { xHandle } : {}),
          eligibleSince: eligible
            ? sql`COALESCE(${wallets.eligibleSince}, ${now.toISOString()}::timestamptz)`
            : null,
        },
      })
    this.lastActivityWrite.set(wallet, now.getTime())

    const [live] = await this.d.db.select().from(rounds).where(eq(rounds.status, 'live')).limit(1)
    let entryView: EnterResult['entry'] = null
    let locked = false
    if (live) {
      const res = await this.claimLock(live.id, wallet, input.sessionId, now)
      if (res) {
        locked = res.locked
        const rows = await this.d.db
          .select()
          .from(tickets)
          .where(and(eq(tickets.roundId, live.id), eq(tickets.wallet, wallet)))
          .orderBy(asc(tickets.idx))
        const outcomes = new Map((await this.d.outcomesFor(rows)).map((o) => [o.ticketId, o]))
        entryView = {
          voided: res.entry.voidReason,
          multMicro: res.entry.multMicro.toString(),
          tickets: rows.map((r) => ({
            id: r.id.toString(),
            idx: r.idx,
            scratched: !!r.scratchedAt,
            void: r.void,
            outcome: outcomes.get(r.id.toString()) ?? null,
          })),
        }
      }
    }
    const nextDropAt = live ? live.endsAt : new Date((window + 1) * roundMs)
    return {
      wallet,
      xHandle,
      eligibleNow: eligible,
      holdingsRaw: bal.value.toString(),
      holdingsUsdMicro: h.toString(),
      ticketsPerDrop: Number(terms.tickets),
      multMicro: terms.multMicro.toString(),
      nudge: {
        extraUsd: nudge.extraUsd.toString(),
        extraTickets: nudge.extraTickets.toString(),
        multGainMicro: nudge.multGainMicro.toString(),
        maxed: nudge.maxed,
      },
      round: live
        ? { id: live.id, startsAt: live.startsAt.toISOString(), endsAt: live.endsAt.toISOString() }
        : null,
      entry: entryView,
      locked,
      nextDropAt: nextDropAt.toISOString(),
      priceState: prices.state,
    }
  }

  /** Decision C: record that `wallet` was active in the current round window (once per window per process). */
  private async markActive(wallet: string, now: Date): Promise<void> {
    const roundMs = this.d.economy.roundSeconds * 1000
    const windowStart = Math.floor(now.getTime() / roundMs) * roundMs
    if (this.activeWindow.get(wallet) === windowStart) return
    await this.d.db
      .insert(activity)
      .values({ wallet, windowStart: new Date(windowStart) })
      .onConflictDoNothing()
    if (this.activeWindow.size > 100_000) this.activeWindow.clear()
    this.activeWindow.set(wallet, windowStart)
  }

  /**
   * Visible-tab heartbeat. From the session that pasted the wallet it keeps the wallet ACTIVE (entered in the
   * next drop) and renews the scratch lock it holds. Writes are throttled.
   */
  async heartbeat(sessionId: string, walletInput: unknown): Promise<void> {
    const wallet = normalizeWalletAddress(walletInput)
    if (!wallet || this.owners.get(wallet) !== sessionId) return
    const now = this.now()
    await this.markActive(wallet, now)
    const last = this.lastActivityWrite.get(wallet) ?? 0
    if (now.getTime() - last >= ACTIVITY_WRITE_THROTTLE_MS) {
      this.lastActivityWrite.set(wallet, now.getTime())
      await this.d.db.update(wallets).set({ lastActiveAt: now }).where(eq(wallets.address, wallet))
    }
    const lease = new Date(now.getTime() + this.d.sessionLockSeconds * 1000)
    await this.d.db
      .update(entries)
      .set({ lockExpiresAt: lease })
      .where(
        and(
          eq(entries.wallet, wallet),
          eq(entries.sessionId, sessionId),
          sql`${entries.roundId} = (SELECT id FROM rounds WHERE status = 'live' ORDER BY id DESC LIMIT 1)`,
        ),
      )
  }

  /** Take or keep the wallet's scratch lock for this round. Returns null when the wallet has no entry. */
  private async claimLock(roundId: number, wallet: string, sessionId: string, now: Date) {
    return this.d.db.transaction(async (tx) => {
      const [e] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.roundId, roundId), eq(entries.wallet, wallet)))
        .for('update')
      if (!e) return null
      const lease = new Date(now.getTime() + this.d.sessionLockSeconds * 1000)
      const expired = !e.sessionId || !e.lockExpiresAt || e.lockExpiresAt <= now
      // idle = the holder hasn't acquired or scratched for SESSION_LOCK_SECONDS (heartbeats alone don't count),
      // so a stranger's tab can never sit on someone's tickets
      const lastAction = e.lastScratchAt ?? now
      const idle =
        e.sessionId !== sessionId && now.getTime() - lastAction.getTime() >= this.d.sessionLockSeconds * 1000
      if (e.sessionId === sessionId || expired || idle) {
        const takingOver = e.sessionId !== sessionId
        const [u] = await tx
          .update(entries)
          .set({ sessionId, lockExpiresAt: lease, ...(takingOver ? { lastScratchAt: now } : {}) })
          .where(and(eq(entries.roundId, roundId), eq(entries.wallet, wallet)))
          .returning()
        return { locked: false, entry: u! }
      }
      return { locked: true, entry: e }
    })
  }

  private async scratchyDecimals(): Promise<number> {
    if (this.decimals === null) this.decimals = (await this.d.chain.getMintInfo(this.d.scratchyMint)).decimals
    return this.decimals
  }
}

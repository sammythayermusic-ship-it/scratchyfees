import { reconcileBalances } from '@scratchy/core'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Alerter } from '../alerts/types'
import type { ChainClient } from '../chain/types'
import type { Db } from '../db/client'
import { payouts, prizeLedger } from '../db/schema'
import type { PauseRegistry } from './pauses'

/**
 * Live accounting invariant (plan invariant 2; audit CRIT-1): the PRIZE wallet's PUMP balance at finalized
 * commitment must equal the ledger (prize_ledger entries at or before that slot).
 *   chain > ledger → an unexplained INFLOW (your seed deposit, a top-up, a stranger's dust): booked as
 *                    `external_in` and it simply joins the next pool snapshot. Never pauses.
 *   chain < ledger → an unexplained OUTFLOW (possible key compromise): hard stop `invariant` after two
 *                    consecutive observations, unless the gap is covered by transfers still in flight.
 * Runs quietly while any PRIZE-side transfer is in flight (their landing is recorded by the payout worker).
 */

export interface ReconcileResult {
  status: 'ok' | 'booked_inflow' | 'waiting' | 'outflow_suspected' | 'paused'
  deltaRaw: bigint
  chainRaw: bigint
  ledgerRaw: bigint
  slot: number
}

export class Reconciler {
  private suspicions = 0
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly d: {
      db: Db
      chain: ChainClient
      prizeAddress: string
      pumpMint: string
      pauses: PauseRegistry
      alerter: Alerter
      intervalMs?: number
    },
  ) {}

  start(): void {
    if (this.timer) return
    const run = () =>
      this.runOnce().catch((e) =>
        this.d.alerter.notify({
          kind: 'invariant.error',
          severity: 'warn',
          message: `reconciler failed: ${(e as Error).message}`,
          dedupeKey: 'invariant.error',
        }),
      )
    void run()
    this.timer = setInterval(run, this.d.intervalMs ?? 60_000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async runOnce(): Promise<ReconcileResult> {
    const db = this.d.db
    const bal = await this.d.chain.getTokenBalance(this.d.prizeAddress, this.d.pumpMint, 'finalized')
    const [{ n }] = (await db.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM prize_ledger`))
      .rows as [{ n: number }]
    if (n === 0) {
      // genesis: whatever the operator funded the PRIZE wallet with is the opening deposit
      await db
        .insert(prizeLedger)
        .values({ kind: 'deposit', amountRaw: bal.value, ref: 'genesis', slot: BigInt(bal.slot) })
        .onConflictDoNothing()
      this.d.alerter.notify({
        kind: 'invariant.genesis',
        severity: 'info',
        message: `prize ledger opened with ${bal.value} raw PUMP (genesis deposit)`,
      })
      return {
        status: 'booked_inflow',
        deltaRaw: bal.value,
        chainRaw: bal.value,
        ledgerRaw: 0n,
        slot: bal.slot,
      }
    }
    const [{ ledger }] = (
      await db.execute<{ ledger: string }>(sql`
        SELECT COALESCE(SUM(amount_raw), 0)::text AS ledger FROM prize_ledger
        WHERE slot IS NULL OR slot <= ${bal.slot}`)
    ).rows as [{ ledger: string }]
    const ledgerRaw = BigInt(ledger)
    const inFlight = await db
      .select({ kind: payouts.kind, signer: payouts.signer, amountRaw: payouts.amountRaw })
      .from(payouts)
      .where(and(eq(payouts.status, 'sending'), inArray(payouts.kind, ['tier', 'jackpot', 'sweep_prize'])))
    const inFlightOut = inFlight.filter((p) => p.signer === 'prize').reduce((s, p) => s + p.amountRaw, 0n)
    const inFlightIn = inFlight.filter((p) => p.kind === 'sweep_prize').reduce((s, p) => s + p.amountRaw, 0n)
    const rec = reconcileBalances(bal.value, ledgerRaw)
    const base = { chainRaw: bal.value, ledgerRaw, slot: bal.slot }

    if (rec.status === 'ok') {
      this.suspicions = 0
      return { status: 'ok', deltaRaw: 0n, ...base }
    }
    if (rec.status === 'inflow') {
      this.suspicions = 0
      if (inFlight.length > 0) return { status: 'waiting', deltaRaw: rec.deltaRaw, ...base } // may be a landed transfer not yet recorded
      await db
        .insert(prizeLedger)
        .values({
          kind: 'external_in',
          amountRaw: rec.deltaRaw,
          ref: `ext:${bal.slot}`,
          slot: BigInt(bal.slot),
        })
        .onConflictDoNothing()
      this.d.alerter.notify({
        kind: 'invariant.inflow',
        severity: 'info',
        message: `booked ${rec.deltaRaw} raw PUMP of unexplained inflow into the PRIZE wallet (deposit/top-up/dust) — it joins the next pool`,
        data: { amountRaw: rec.deltaRaw.toString() },
      })
      return { status: 'booked_inflow', deltaRaw: rec.deltaRaw, ...base }
    }
    // outflow: covered by transfers that may already have landed?
    if (rec.deltaRaw <= inFlightOut + inFlightIn)
      return { status: 'waiting', deltaRaw: -rec.deltaRaw, ...base }
    this.suspicions++
    if (this.suspicions < 2) return { status: 'outflow_suspected', deltaRaw: -rec.deltaRaw, ...base }
    await this.d.pauses.set(
      'invariant',
      `PRIZE wallet holds ${rec.deltaRaw} raw PUMP less than the ledger explains (slot ${bal.slot}) — possible key compromise; payouts stopped`,
    )
    return { status: 'paused', deltaRaw: -rec.deltaRaw, ...base }
  }
}

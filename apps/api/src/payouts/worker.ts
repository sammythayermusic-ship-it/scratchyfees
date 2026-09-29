import { and, asc, eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Alerter } from '../alerts/types'
import { payoutMemo, TransientChainError, type ChainClient, type SignerRole } from '../chain/types'
import type { Db } from '../db/client'
import { jackpot, payoutAttempts, payouts, prizeLedger, wallets } from '../db/schema'
import { classifyFailure } from './classify'

/**
 * PLAN.md §5 payout engine — exactly-once SPL transfers from the PRIZE (hot) wallet, plus the fee sweeper's
 * CREATOR-signed 70/30 transfers (kind sweep_prize / sweep_ops), which get the same guarantees.
 *
 * Protocol (never double-pays, never loses a payout):
 *  1. Every signed attempt is persisted BEFORE it is sent, inside a FENCED transaction that re-checks — under a
 *     row lock — that this worker still owns the lease and that no other attempt is pending. A worker whose
 *     lease expired mid-build discards its tx unsent. (payout_id, attempt) is also unique.
 *  2. While an attempt's blockhash is valid, the identical bytes are re-broadcast every RESEND_MS (identical
 *     bytes = identical signature → the network applies it at most once).
 *  3. A new attempt is built only once every earlier one is PROVEN dead: finalized block height has passed its
 *     lastValidBlockHeight, and — twice, ≥ ABSENCE_RECHECK_MS apart — a full-history status query answered
 *     from a view at or after that point doesn't know it, and the transaction lookup doesn't find it either.
 *     A 'processed' status is never a proof of anything: we wait.
 *  4. Up to MAX_ATTEMPTS per cycle; then `failed` → auto-retry queue. Deterministic errors → failed_permanent
 *     (funds stay in the pool; a jackpot returns to the pot). Balance errors pause. A payout whose simulation
 *     keeps failing pauses PRIZE payouts with a critical alert instead of retrying silently forever.
 *  5. Status writes are conditional (never overwrite confirmed / failed_permanent; lease-fenced).
 * Workers claim with FOR UPDATE SKIP LOCKED + a lease renewed per row; several workers can run safely.
 * Hard pauses (manual / invariant / breaker_mismatch / mint_changed / payouts_stuck) hold PRIZE payouts AND the
 * sweep transfers INTO the PRIZE wallet; soft pauses (low_gas / low_pool) hold PRIZE payouts only.
 */

export const RESEND_MS = 1_500
export const MAX_ATTEMPTS = 4 // initial + "retry ×3" (PLAN §5)
export const LEASE_MS = 30_000
export const ABSENCE_RECHECK_MS = 10_000
export const STUCK_SIM_FAILURES = 10
const DEFAULT_CU = 120_000
const MAX_CU = 1_400_000

export interface GateHold {
  reason: string
  /** hard pauses also stop fee transfers INTO the PRIZE wallet (possible key compromise, kill switch) */
  hard: boolean
}

export interface PayoutGate {
  /** why new PRIZE transfers must not be built right now, or null */
  hold(): GateHold | null
  /** a send failed for balance reasons — ask the monitor to re-check and pause */
  onBalanceTrouble(kind: 'low_gas' | 'low_pool', detail: string): void
  /** a PRIZE payout keeps failing to simulate — pause PRIZE payouts (hard) */
  onStuck(detail: string): void
  /** a superseded attempt LANDED after its payout confirmed — a double payment: hard stop */
  onDoublePay(detail: string): void
}

export type PayoutRow = typeof payouts.$inferSelect
type AttemptRow = typeof payoutAttempts.$inferSelect

export interface PayoutEvent {
  type: 'payout'
  payout: PayoutRow
}

export interface PayoutWorkerDeps {
  db: Db
  chain: ChainClient
  alerter: Alerter
  gate: PayoutGate
  /** the mint prizes are paid in (devnet: the mock PUMP mint) */
  mint: string
  deployId: string
  concurrency: number
  priorityFeeCapMicroLamports: number
  /** Decision D knob: 0 = always pay ATA rent; N > 0 = after N re-creations for a wallet, wait for its own ATA */
  ataRecreateLimit?: number
  onEvent?: (e: PayoutEvent) => void
  now?: () => Date
  workerId?: string
}

export class PayoutWorker {
  private readonly id: string
  private running = false
  private wakeResolve: (() => void) | null = null
  private loop: Promise<void> | null = null
  private readonly now: () => Date

  constructor(private readonly d: PayoutWorkerDeps) {
    this.id = d.workerId ?? `pw-${randomUUID().slice(0, 8)}`
    this.now = d.now ?? (() => new Date())
  }

  /** wake the loop immediately (called right after a winning scratch is committed) */
  wake(): void {
    this.wakeResolve?.()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.loop = (async () => {
      while (this.running) {
        let busy = 0
        try {
          busy = await this.tick()
        } catch (e) {
          this.d.alerter.notify({
            kind: 'payout.worker_error',
            severity: 'warn',
            message: `payout worker tick failed: ${(e as Error).message}`,
            dedupeKey: 'payout.worker_error',
          })
        }
        await new Promise<void>((res) => {
          const t = setTimeout(res, busy > 0 ? 400 : 1_000)
          this.wakeResolve = () => {
            clearTimeout(t)
            res()
          }
        })
        this.wakeResolve = null
      }
    })()
  }

  async stop(): Promise<void> {
    this.running = false
    this.wake()
    await this.loop
  }

  /** Claim and process one batch. Returns how many payouts are still in flight/active. */
  async tick(): Promise<number> {
    await this.watchSuperseded()
    const claimed = await this.claim(this.d.gate.hold())
    if (claimed.length === 0) return 0
    let active = 0
    const queue = [...claimed]
    const lanes = Array.from({ length: Math.min(this.d.concurrency, queue.length) }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          // renew the lease and re-read the row: never act on a stale snapshot
          const p = await this.renewLease(id)
          if (!p) continue
          if (await this.processOne(p, this.d.gate.hold())) active++
        } catch (e) {
          active++
          if (!(e instanceof TransientChainError)) {
            this.d.alerter.notify({
              kind: 'payout.error',
              severity: 'warn',
              message: `payout #${id}: ${(e as Error).message}`,
              dedupeKey: `payout.error.${id}`,
            })
          }
        } finally {
          await this.release(id)
        }
      }
    })
    await Promise.all(lanes)
    return active
  }

  // ── claiming / leases ──────────────────────────────────────────────────────
  private async claim(hold: GateHold | null): Promise<bigint[]> {
    const now = this.now()
    const nowIso = now.toISOString()
    const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString()
    // while held: in-flight transfers are always tracked; creator sweeps continue unless the hold is hard,
    // in which case only the 30% OPS leg may still move (nothing more goes INTO a possibly compromised PRIZE)
    const allowed = !hold
      ? sql`TRUE`
      : hold.hard
        ? sql`(status = 'sending' OR kind = 'sweep_ops')`
        : sql`(status = 'sending' OR signer = 'creator')`
    const res = await this.d.db.execute<{ id: string }>(sql`
      UPDATE payouts SET lease_owner = ${this.id}, lease_expires_at = ${leaseUntil}::timestamptz
      WHERE id IN (
        SELECT id FROM payouts
        WHERE (status = 'sending'
               OR (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ${nowIso}::timestamptz))
               OR (status = 'failed' AND next_attempt_at <= ${nowIso}::timestamptz))
          AND ${allowed}
          AND (lease_expires_at IS NULL OR lease_expires_at < ${nowIso}::timestamptz)
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT ${this.d.concurrency}
      )
      RETURNING id`)
    return res.rows.map((r) => BigInt(r.id))
  }

  private async renewLease(id: bigint): Promise<PayoutRow | null> {
    const until = new Date(this.now().getTime() + LEASE_MS)
    const [row] = await this.d.db
      .update(payouts)
      .set({ leaseExpiresAt: until })
      .where(and(eq(payouts.id, id), eq(payouts.leaseOwner, this.id)))
      .returning()
    return row ?? null
  }

  private async release(id: bigint): Promise<void> {
    await this.d.db
      .update(payouts)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(and(eq(payouts.id, id), eq(payouts.leaseOwner, this.id)))
  }

  // ── one payout ─────────────────────────────────────────────────────────────
  /** returns true while the payout still needs attention (in flight / waiting) */
  private async processOne(p: PayoutRow, hold: GateHold | null): Promise<boolean> {
    if (p.status === 'confirmed' || p.status === 'failed_permanent' || p.status === 'held') return false
    const attempts = await this.d.db
      .select()
      .from(payoutAttempts)
      .where(eq(payoutAttempts.payoutId, p.id))
      .orderBy(asc(payoutAttempts.attempt))
    let pending = attempts.filter((a) => a.status === 'pending')

    if (pending.length > 0) {
      // (a) did a pending attempt land? 'processed' proves nothing yet → wait
      const st = await this.d.chain.getSignatureStatuses(pending.map((a) => a.signature))
      const unknown: AttemptRow[] = []
      for (let i = 0; i < pending.length; i++) {
        const s = st.statuses[i]
        const a = pending[i]!
        if (!s) {
          unknown.push(a)
          continue
        }
        if (s.confirmationStatus !== 'confirmed' && s.confirmationStatus !== 'finalized') return true
        if (s.err === null) {
          await this.finalizeLanded(p, a, s.slot)
          return false
        }
        await this.d.db
          .update(payoutAttempts)
          .set({ status: 'failed_onchain', landedSlot: BigInt(s.slot), error: s.err })
          .where(eq(payoutAttempts.id, a.id))
        const cls = classifyFailure(s.err)
        if (cls === 'permanent') return this.failPermanently(p, s.err)
        if ((cls === 'low_gas' || cls === 'low_pool') && p.signer === 'prize')
          this.d.gate.onBalanceTrouble(cls, s.err)
      }
      pending = unknown

      // (b) prove expiry — only for attempts past their last valid block height
      if (pending.length > 0) {
        const fin = await this.d.chain.getHeightAndSlot('finalized')
        const candidates = pending.filter((a) => fin.blockHeight > Number(a.lastValidBlockHeight))
        if (candidates.length > 0) {
          const proof = await this.d.chain.getSignatureStatuses(candidates.map((a) => a.signature))
          if (proof.contextSlot < fin.slot) return true // RPC view behind the expiry point: prove nothing yet
          for (let i = 0; i < candidates.length; i++) {
            if (proof.statuses[i]) return true // it IS known (landed or processing) — step (a) resolves it next tick
            if (!(await this.provenAbsent(candidates[i]!))) return true
          }
          pending = pending.filter((a) => !candidates.includes(a))
        }
      }

      // (c) still live → re-broadcast the identical bytes, never build a second attempt
      if (pending.length > 0) {
        const now = this.now().getTime()
        for (const a of pending) {
          if (!a.lastSentAt || now - a.lastSentAt.getTime() >= RESEND_MS) {
            try {
              await this.d.chain.sendRaw(Buffer.from(a.txBase64, 'base64'))
            } catch {
              /* transient: the next tick re-broadcasts */
            }
            await this.d.db
              .update(payoutAttempts)
              .set({ lastSentAt: this.now() })
              .where(eq(payoutAttempts.id, a.id))
          }
        }
        return true
      }
    }

    // ── no live attempt: decide whether to build one ─────────────────────────
    if (hold && (p.signer === 'prize' || (hold.hard && p.kind === 'sweep_prize'))) {
      if (p.status !== 'queued') await this.setStatus(p, 'queued', { error: `held: ${hold.reason}` })
      return false
    }

    const cycleAttempts = attempts.length % MAX_ATTEMPTS
    const cycles = Math.floor(attempts.length / MAX_ATTEMPTS)
    if (attempts.length > 0 && cycleAttempts === 0 && p.status !== 'failed') {
      const backoffMs = Math.min(30_000 * 2 ** Math.min(cycles - 1, 5), 15 * 60_000)
      await this.setStatus(p, 'failed', {
        nextAttemptAt: new Date(this.now().getTime() + backoffMs),
        error: `${MAX_ATTEMPTS} attempts did not land; auto-retry in ${Math.round(backoffMs / 1000)}s`,
      })
      this.d.alerter.notify({
        kind: 'payout.failed',
        severity: 'warn',
        message: `payout #${p.id} (${p.amountRaw} raw → ${p.wallet}) failed ${MAX_ATTEMPTS} attempts; queued for auto-retry`,
        immediate: true,
      })
      return false
    }

    // Decision D knob: stop paying rent for wallets that keep closing their PUMP account
    const limit = this.d.ataRecreateLimit ?? 0
    if (limit > 0 && (p.kind === 'tier' || p.kind === 'jackpot')) {
      const [w] = await this.d.db
        .select({ n: wallets.ataCreatedCount })
        .from(wallets)
        .where(eq(wallets.address, p.wallet))
      if ((w?.n ?? 0) >= limit && !(await this.d.chain.ataExists(p.wallet, this.d.mint))) {
        await this.setStatus(p, 'queued', {
          nextAttemptAt: new Date(this.now().getTime() + 60_000),
          error: `waiting for the wallet to reopen its PUMP account (ATA_RECREATE_LIMIT ${limit})`,
        })
        return false
      }
    }

    // build → simulate (→ resize compute) → fenced persist → send
    const fee = Math.min(await this.d.chain.estimatePriorityFee(), this.d.priorityFeeCapMicroLamports)
    const request = {
      signer: p.signer as SignerRole,
      recipient: p.wallet,
      mint: this.d.mint,
      amountRaw: p.amountRaw,
      memo: payoutMemo(this.d.deployId, p.id),
      priorityFeeMicroLamports: fee,
      computeUnitLimit: DEFAULT_CU,
    }
    let tx = await this.d.chain.buildTransferTx(request)
    let sim = await this.d.chain.simulate(tx.bytes)
    if (sim.ok && sim.unitsConsumed && sim.unitsConsumed > DEFAULT_CU * 0.8) {
      request.computeUnitLimit = Math.min(MAX_CU, Math.ceil(sim.unitsConsumed * 1.3))
      tx = await this.d.chain.buildTransferTx(request)
      sim = await this.d.chain.simulate(tx.bytes)
    }
    if (!sim.ok) return this.onSimulationFailure(p, sim.error, sim.permanent, cycleAttempts, sim.logs)
    if (p.simFailures > 0) await this.d.db.update(payouts).set({ simFailures: 0 }).where(eq(payouts.id, p.id))

    const persisted = await this.d.db.transaction(async (db) => {
      const [locked] = await db.select().from(payouts).where(eq(payouts.id, p.id)).for('update')
      const now = this.now()
      if (
        !locked ||
        locked.leaseOwner !== this.id ||
        !locked.leaseExpiresAt ||
        locked.leaseExpiresAt <= now ||
        locked.status === 'confirmed' ||
        locked.status === 'failed_permanent' ||
        locked.status === 'held'
      ) {
        return false
      }
      const current = await db.select().from(payoutAttempts).where(eq(payoutAttempts.payoutId, p.id))
      if (
        current.length !== attempts.length ||
        current.some((a) => a.status === 'pending' || a.status === 'superseded')
      ) {
        return false
      }
      await db.insert(payoutAttempts).values({
        payoutId: p.id,
        attempt: attempts.length + 1,
        signature: tx.signature,
        txBase64: Buffer.from(tx.bytes).toString('base64'),
        blockhash: tx.blockhash,
        lastValidBlockHeight: BigInt(tx.lastValidBlockHeight),
        createsAta: tx.createsAta,
        status: 'pending',
        lastSentAt: now,
      })
      await db
        .update(payouts)
        .set({
          status: 'sending',
          sentAt: locked.sentAt ?? now,
          error: null,
          nextAttemptAt: null,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        })
        .where(eq(payouts.id, p.id))
      return true
    })
    if (!persisted) return true // lost the lease / someone else is on it: discard this tx unsent
    this.emit(p.id)
    try {
      await this.d.chain.sendRaw(tx.bytes)
    } catch {
      /* persisted: the next tick re-broadcasts the identical bytes */
    }
    return true
  }

  /**
   * An expired attempt is only declared dead after TWO absence observations ≥ ABSENCE_RECHECK_MS apart, the
   * second cross-checked with the transaction lookup (guards against a pruned / lagging RPC backend).
   */
  private async provenAbsent(a: AttemptRow): Promise<boolean> {
    const now = this.now()
    if (!a.absentSince) {
      await this.d.db.update(payoutAttempts).set({ absentSince: now }).where(eq(payoutAttempts.id, a.id))
      return false
    }
    if (now.getTime() - a.absentSince.getTime() < ABSENCE_RECHECK_MS) return false
    const signer = await this.signerOf(a.payoutId)
    const lookup = await this.d.chain.getOwnerTokenDeltas(a.signature, signer)
    if (lookup) return false // the ledger knows it after all — step (a) resolves it
    await this.d.db
      .update(payoutAttempts)
      .set({ status: 'expired' })
      .where(and(eq(payoutAttempts.id, a.id), sql`${payoutAttempts.status} IN ('pending', 'superseded')`))
    return true
  }

  private async signerOf(payoutId: bigint): Promise<string> {
    const [p] = await this.d.db
      .select({ signer: payouts.signer })
      .from(payouts)
      .where(eq(payouts.id, payoutId))
    return p?.signer === 'creator'
      ? (this.d.chain.creatorAddress ?? this.d.chain.prizeAddress)
      : this.d.chain.prizeAddress
  }

  private async onSimulationFailure(
    p: PayoutRow,
    error: string | null,
    permanentHint: boolean,
    cycleAttempts: number,
    logs: readonly string[] = [],
  ): Promise<boolean> {
    const cls = classifyFailure(error, permanentHint, logs)
    if (cls === 'permanent') return this.failPermanently(p, error ?? 'simulation failed')
    const [row] = await this.d.db
      .update(payouts)
      .set({ simFailures: sql`${payouts.simFailures} + 1` })
      .where(eq(payouts.id, p.id))
      .returning({ n: payouts.simFailures })
    const failures = row?.n ?? 1
    if (cls === 'low_gas' || cls === 'low_pool') {
      if (p.signer === 'prize') this.d.gate.onBalanceTrouble(cls, error ?? cls)
      else
        this.d.alerter.notify({
          kind: 'sweep.creator_balance',
          severity: 'warn',
          message: `CREATOR cannot send sweep transfer #${p.id} (${cls}): ${error}`,
          dedupeKey: 'sweep.creator_balance',
          immediate: true,
        })
      await this.setStatus(p, 'queued', {
        error: `${cls}: ${error}`,
        nextAttemptAt: new Date(this.now().getTime() + 30_000),
      })
      return false
    }
    if (failures >= STUCK_SIM_FAILURES) {
      const detail = `payout #${p.id} (${p.kind} → ${p.wallet}) failed simulation ${failures}× in a row: ${error}`
      if (p.signer === 'prize') this.d.gate.onStuck(detail)
      else
        this.d.alerter.notify({
          kind: 'sweep.stuck',
          severity: 'critical',
          message: detail,
          immediate: true,
          dedupeKey: `sweep.stuck.${p.id}`,
        })
    }
    const backoff = 1_000 * 2 ** Math.min(cycleAttempts + Math.min(failures, 5), 6)
    await this.setStatus(p, p.status === 'failed' ? 'failed' : 'queued', {
      nextAttemptAt: new Date(this.now().getTime() + backoff),
      error: `simulation: ${error}`,
    })
    return true
  }

  private async finalizeLanded(p: PayoutRow, a: AttemptRow, slot: number): Promise<void> {
    const confirmed = await this.d.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(payouts).where(eq(payouts.id, p.id)).for('update')
      if (!locked || locked.status === 'confirmed') return null
      await tx
        .update(payoutAttempts)
        .set({ status: 'landed', landedSlot: BigInt(slot) })
        .where(eq(payoutAttempts.id, a.id))
      // any other still-pending attempt must never land unnoticed: watch it until it is provably dead
      await tx
        .update(payoutAttempts)
        .set({ status: 'superseded' })
        .where(and(eq(payoutAttempts.payoutId, p.id), eq(payoutAttempts.status, 'pending')))
      const [row] = await tx
        .update(payouts)
        .set({
          status: 'confirmed',
          txSig: a.signature,
          landedSlot: BigInt(slot),
          ataCreated: a.createsAta,
          confirmedAt: this.now(),
          heldReason: null,
          error: null,
          simFailures: 0,
        })
        .where(eq(payouts.id, p.id))
        .returning()
      if (p.signer === 'prize') {
        await tx
          .insert(prizeLedger)
          .values({ kind: 'payout_out', amountRaw: -p.amountRaw, ref: `payout:${p.id}`, slot: BigInt(slot) })
          .onConflictDoNothing()
      } else if (p.kind === 'sweep_prize') {
        await tx
          .insert(prizeLedger)
          .values({ kind: 'sweep_in', amountRaw: p.amountRaw, ref: `payout:${p.id}`, slot: BigInt(slot) })
          .onConflictDoNothing()
      }
      let ataCount = 0
      if (p.kind === 'tier' || p.kind === 'jackpot') {
        const [w] = await tx
          .update(wallets)
          .set({
            totalWonRaw: sql`${wallets.totalWonRaw} + ${p.amountRaw}`,
            ataCreatedCount: sql`${wallets.ataCreatedCount} + ${a.createsAta ? 1 : 0}`,
          })
          .where(eq(wallets.address, p.wallet))
          .returning({ n: wallets.ataCreatedCount })
        ataCount = w?.n ?? 0
      }
      return row ? { row, ataCount } : null
    })
    if (!confirmed) return
    this.d.onEvent?.({ type: 'payout', payout: confirmed.row })
    if (a.createsAta && confirmed.ataCount >= 2) {
      this.d.alerter.notify({
        kind: 'payout.ata_recreated',
        severity: 'warn',
        message: `wallet ${p.wallet} needed its PUMP account re-created ${confirmed.ataCount}× (rent paid each time) — possible rent farming; see ATA_RECREATE_LIMIT`,
        dedupeKey: `payout.ata_recreated.${p.wallet}`,
      })
    }
  }

  /** Backstop: an attempt superseded by a landed sibling must never land too. If it does, stop everything. */
  private async watchSuperseded(): Promise<void> {
    const rows = await this.d.db
      .select()
      .from(payoutAttempts)
      .where(eq(payoutAttempts.status, 'superseded'))
      .limit(50)
    if (!rows.length) return
    const st = await this.d.chain.getSignatureStatuses(rows.map((r) => r.signature))
    const fin = await this.d.chain.getHeightAndSlot('finalized')
    for (let i = 0; i < rows.length; i++) {
      const s = st.statuses[i]
      const a = rows[i]!
      if (
        s &&
        s.err === null &&
        (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')
      ) {
        await this.d.db
          .update(payoutAttempts)
          .set({ status: 'landed_duplicate', landedSlot: BigInt(s.slot) })
          .where(eq(payoutAttempts.id, a.id))
        this.d.gate.onDoublePay(
          `payout #${a.payoutId}: a second attempt (${a.signature}) landed — double payment`,
        )
      } else if (!s && fin.blockHeight > Number(a.lastValidBlockHeight) && st.contextSlot >= fin.slot) {
        await this.provenAbsent(a)
      }
    }
  }

  private async failPermanently(p: PayoutRow, error: string): Promise<false> {
    const row = await this.d.db.transaction(async (tx) => {
      const [u] = await tx
        .update(payouts)
        .set({ status: 'failed_permanent', error })
        .where(and(eq(payouts.id, p.id), sql`${payouts.status} NOT IN ('confirmed', 'failed_permanent')`))
        .returning()
      if (u && p.kind === 'jackpot') {
        // Decision B: a jackpot that can never be paid returns to the pot (not to the free pool)
        await tx
          .update(jackpot)
          .set({ amountRaw: sql`${jackpot.amountRaw} + ${p.amountRaw}`, updatedAt: this.now() })
          .where(eq(jackpot.id, 1))
      }
      return u ?? null
    })
    if (!row) return false
    this.d.alerter.notify({
      kind: 'payout.failed_permanent',
      severity: 'critical',
      message:
        `payout #${p.id} (${p.kind}) to ${p.wallet} can never succeed (${error}); ` +
        (p.kind === 'jackpot'
          ? `${p.amountRaw} raw returned to the jackpot pot`
          : `${p.amountRaw} raw stays in the pool`),
      immediate: true,
    })
    this.d.onEvent?.({ type: 'payout', payout: row })
    return false
  }

  /** Conditional write: never overwrites a terminal status, only while we hold the lease. */
  private async setStatus(
    p: PayoutRow,
    status: string,
    extra: Partial<Pick<PayoutRow, 'nextAttemptAt' | 'error' | 'sentAt'>> = {},
  ): Promise<void> {
    const [row] = await this.d.db
      .update(payouts)
      .set({ status, ...extra })
      .where(
        and(
          eq(payouts.id, p.id),
          eq(payouts.leaseOwner, this.id),
          sql`${payouts.status} NOT IN ('confirmed', 'failed_permanent')`,
        ),
      )
      .returning()
    if (row) this.d.onEvent?.({ type: 'payout', payout: row })
  }

  private emit(id: bigint): void {
    void this.d.db
      .select()
      .from(payouts)
      .where(eq(payouts.id, id))
      .then(([row]) => {
        if (row) this.d.onEvent?.({ type: 'payout', payout: row })
      })
  }
}

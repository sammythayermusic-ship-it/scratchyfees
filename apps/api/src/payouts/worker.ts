import { and, asc, eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Alerter } from '../alerts/types'
import { payoutMemo, TransientChainError, type ChainClient, type SignerRole } from '../chain/types'
import type { Db } from '../db/client'
import { payoutAttempts, payouts, prizeLedger, wallets } from '../db/schema'
import { classifyFailure } from './classify'

/**
 * PLAN.md §5 payout engine — exactly-once SPL payouts from the PRIZE (hot) wallet.
 *
 * Protocol (never double-pays, never loses a payout):
 *  1. Every signed attempt is persisted in payout_attempts BEFORE it is sent.
 *  2. While an attempt's blockhash is valid, the identical bytes are re-broadcast every RESEND_MS
 *     (identical bytes = identical signature, so the network applies it at most once).
 *  3. A new attempt is built only after the previous one is PROVEN dead: finalized block height has
 *     passed its lastValidBlockHeight AND a signature-status query (full history) answered from a view at
 *     or after that point doesn't know it. So at most one attempt can ever be live.
 *  4. Up to MAX_ATTEMPTS attempts per cycle with backoff; then `failed` → auto-retry queue.
 *     Deterministic errors → `failed_permanent` (funds stay in the pool, alert). Balance errors pause.
 * Workers claim payouts with FOR UPDATE SKIP LOCKED + a lease, so several workers can run safely.
 *
 * The same queue carries the fee sweeper's CREATOR-signed 70/30 transfers (kind sweep_prize / sweep_ops)
 * so they get the identical exactly-once guarantees. Payout pauses hold only PRIZE-signed transfers —
 * sweeps keep flowing (refilling the pool is exactly what a low-pool pause needs).
 */

export const RESEND_MS = 1_500
export const MAX_ATTEMPTS = 4 // initial + "retry ×3" (PLAN §5)
export const LEASE_MS = 30_000

export interface PayoutGate {
  /** reason new attempts must not be built right now (manual / low_gas / low_pool / invariant …) or null */
  globalHold(): string | null
  /** a send failed for balance reasons — ask the monitor to re-check and pause */
  onBalanceTrouble(kind: 'low_gas' | 'low_pool', detail: string): void
}

export type PayoutRow = typeof payouts.$inferSelect

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
    const hold = this.d.gate.globalHold()
    const claimed = await this.claim(hold !== null)
    if (claimed.length === 0) return 0
    let active = 0
    const queue = [...claimed]
    const workers = Array.from({ length: Math.min(this.d.concurrency, queue.length) }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        try {
          const stillActive = await this.processOne(p, hold)
          if (stillActive) active++
        } catch (e) {
          active++
          if (!(e instanceof TransientChainError)) {
            this.d.alerter.notify({
              kind: 'payout.error',
              severity: 'warn',
              message: `payout #${p.id}: ${(e as Error).message}`,
              dedupeKey: `payout.error.${p.id}`,
            })
          }
        } finally {
          await this.release(p.id)
        }
      }
    })
    await Promise.all(workers)
    return active
  }

  // ── claiming ───────────────────────────────────────────────────────────────
  private async claim(inFlightOnly: boolean): Promise<PayoutRow[]> {
    // one clock for everything (the injectable `now`), never mixed with the database's now()
    const now = this.now()
    const leaseUntil = new Date(now.getTime() + LEASE_MS)
    const nowIso = now.toISOString()
    const res = await this.d.db.execute<{ id: string }>(sql`
      UPDATE payouts SET lease_owner = ${this.id}, lease_expires_at = ${leaseUntil.toISOString()}::timestamptz
      WHERE id IN (
        SELECT id FROM payouts
        WHERE (status IN ('queued', 'sending')
               OR (status = 'failed' AND next_attempt_at <= ${nowIso}::timestamptz))
          -- while payouts are held, only in-flight prize transfers are tracked; creator sweeps continue
          AND (${!inFlightOnly} OR status = 'sending' OR signer = 'creator')
          AND (lease_expires_at IS NULL OR lease_expires_at < ${nowIso}::timestamptz)
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT ${Math.max(this.d.concurrency * 4, 16)}
      )
      RETURNING id`)
    if (res.rows.length === 0) return []
    const ids = res.rows.map((r) => BigInt(r.id))
    return this.d.db
      .select()
      .from(payouts)
      .where(
        sql`${payouts.id} IN (${sql.join(
          ids.map((i) => sql`${i}`),
          sql`, `,
        )})`,
      )
      .orderBy(asc(payouts.id))
  }

  private async release(id: bigint): Promise<void> {
    await this.d.db
      .update(payouts)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(and(eq(payouts.id, id), eq(payouts.leaseOwner, this.id)))
  }

  // ── one payout ─────────────────────────────────────────────────────────────
  /** returns true while the payout still needs attention (in flight / waiting) */
  private async processOne(p: PayoutRow, hold: string | null): Promise<boolean> {
    const attempts = await this.d.db
      .select()
      .from(payoutAttempts)
      .where(eq(payoutAttempts.payoutId, p.id))
      .orderBy(asc(payoutAttempts.attempt))
    let pending = attempts.filter((a) => a.status === 'pending')

    if (pending.length > 0) {
      // (a) did any pending attempt land?
      const st = await this.d.chain.getSignatureStatuses(pending.map((a) => a.signature))
      for (let i = 0; i < pending.length; i++) {
        const s = st.statuses[i]
        const a = pending[i]!
        if (!s || s.confirmationStatus === 'processed' || s.confirmationStatus === null) continue
        if (s.err === null) {
          await this.finalizeLanded(p, a, s.slot)
          return false
        }
        // landed but failed on-chain: the transfer did not happen (atomic) — safe to rebuild
        await this.d.db
          .update(payoutAttempts)
          .set({ status: 'failed_onchain', landedSlot: BigInt(s.slot), error: s.err })
          .where(eq(payoutAttempts.id, a.id))
        const cls = classifyFailure(s.err)
        if (cls === 'permanent') return this.failPermanently(p, s.err)
        if ((cls === 'low_gas' || cls === 'low_pool') && p.signer === 'prize') this.d.gate.onBalanceTrouble(cls, s.err)
      }
      pending = pending.filter((_, i) => {
        const s = st.statuses[i]
        return !(s && s.err !== null && s.confirmationStatus !== 'processed')
      })

      // (b) prove expiry for pending attempts whose blockhash is past its last valid height
      if (pending.length > 0) {
        const fin = await this.d.chain.getHeightAndSlot('finalized')
        const expiredCandidates = pending.filter((a) => fin.blockHeight > Number(a.lastValidBlockHeight))
        if (expiredCandidates.length > 0) {
          const proof = await this.d.chain.getSignatureStatuses(expiredCandidates.map((a) => a.signature))
          if (proof.contextSlot >= fin.slot) {
            for (let i = 0; i < expiredCandidates.length; i++) {
              const s = proof.statuses[i]
              const a = expiredCandidates[i]!
              if (s && s.err === null && s.confirmationStatus !== 'processed') {
                await this.finalizeLanded(p, a, s.slot) // landed right before expiry
                return false
              }
              if (s === null) {
                await this.d.db
                  .update(payoutAttempts)
                  .set({ status: 'expired' })
                  .where(eq(payoutAttempts.id, a.id))
              }
            }
            pending = pending.filter((a) => !expiredCandidates.includes(a))
          } else {
            return true // RPC view is behind the expiry point — can't prove anything yet, wait
          }
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
    if (p.status === 'held' || p.status === 'confirmed' || p.status === 'failed_permanent') return false
    if (hold && p.signer === 'prize') {
      if (p.status !== 'queued') await this.setStatus(p.id, 'queued', { error: `held: ${hold}` })
      return false
    }

    const cycleAttempts = attempts.length % MAX_ATTEMPTS
    const cycles = Math.floor(attempts.length / MAX_ATTEMPTS)
    if (attempts.length > 0 && cycleAttempts === 0 && p.status !== 'failed') {
      // a full cycle of attempts provably failed → auto-retry queue
      const backoffMs = Math.min(30_000 * 2 ** Math.min(cycles - 1, 5), 15 * 60_000)
      await this.setStatus(p.id, 'failed', {
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
    if (p.nextAttemptAt && this.now() < p.nextAttemptAt && p.status !== 'failed') return true

    // build → simulate → persist → send
    const fee = Math.min(await this.d.chain.estimatePriorityFee(), this.d.priorityFeeCapMicroLamports)
    const tx = await this.d.chain.buildTransferTx({
      signer: p.signer as SignerRole,
      recipient: p.wallet,
      mint: this.d.mint,
      amountRaw: p.amountRaw,
      memo: payoutMemo(this.d.deployId, p.id),
      priorityFeeMicroLamports: fee,
    })
    const sim = await this.d.chain.simulate(tx.bytes)
    if (!sim.ok) {
      const cls = classifyFailure(sim.error, sim.permanent)
      if (cls === 'permanent') return this.failPermanently(p, sim.error ?? 'simulation failed')
      if (cls === 'low_gas' || cls === 'low_pool') {
        if (p.signer === 'prize') this.d.gate.onBalanceTrouble(cls, sim.error ?? cls)
        else
          this.d.alerter.notify({
            kind: 'sweep.creator_balance',
            severity: 'warn',
            message: `CREATOR cannot send sweep transfer #${p.id} (${cls}): ${sim.error}`,
            dedupeKey: 'sweep.creator_balance',
            immediate: true,
          })
        await this.setStatus(p.id, 'queued', {
          error: `${cls}: ${sim.error}`,
          nextAttemptAt: new Date(this.now().getTime() + 30_000),
        })
        return false
      }
      const backoff = 1_000 * 2 ** Math.min(cycleAttempts, 4)
      await this.setStatus(p.id, p.status === 'failed' ? 'failed' : 'queued', {
        nextAttemptAt: new Date(this.now().getTime() + backoff),
        error: `simulation: ${sim.error}`,
      })
      return true
    }

    await this.d.db.insert(payoutAttempts).values({
      payoutId: p.id,
      attempt: attempts.length + 1,
      signature: tx.signature,
      txBase64: Buffer.from(tx.bytes).toString('base64'),
      blockhash: tx.blockhash,
      lastValidBlockHeight: BigInt(tx.lastValidBlockHeight),
      createsAta: tx.createsAta,
      status: 'pending',
      lastSentAt: this.now(),
    })
    await this.setStatus(p.id, 'sending', {
      sentAt: p.sentAt ?? this.now(),
      error: null,
      nextAttemptAt: null,
    })
    try {
      await this.d.chain.sendRaw(tx.bytes)
    } catch {
      /* persisted: the next tick re-broadcasts the identical bytes */
    }
    return true
  }

  private async finalizeLanded(
    p: PayoutRow,
    a: typeof payoutAttempts.$inferSelect,
    slot: number,
  ): Promise<void> {
    const confirmed = await this.d.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(payouts).where(eq(payouts.id, p.id)).for('update')
      if (!locked || locked.status === 'confirmed') return null
      await tx
        .update(payoutAttempts)
        .set({ status: 'landed', landedSlot: BigInt(slot) })
        .where(eq(payoutAttempts.id, a.id))
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
        })
        .where(eq(payouts.id, p.id))
        .returning()
      if (p.signer === 'prize') {
        // PRIZE wallet outflow
        await tx
          .insert(prizeLedger)
          .values({ kind: 'payout_out', amountRaw: -p.amountRaw, ref: `payout:${p.id}`, slot: BigInt(slot) })
          .onConflictDoNothing()
      } else if (p.kind === 'sweep_prize') {
        // PRIZE wallet inflow from the 70% fee split
        await tx
          .insert(prizeLedger)
          .values({ kind: 'sweep_in', amountRaw: p.amountRaw, ref: `payout:${p.id}`, slot: BigInt(slot) })
          .onConflictDoNothing()
      }
      if (p.kind === 'tier' || p.kind === 'jackpot') {
        await tx
          .update(wallets)
          .set({
            totalWonRaw: sql`${wallets.totalWonRaw} + ${p.amountRaw}`,
            ataCreatedCount: sql`${wallets.ataCreatedCount} + ${a.createsAta ? 1 : 0}`,
          })
          .where(eq(wallets.address, p.wallet))
      }
      return row ?? null
    })
    if (confirmed) this.d.onEvent?.({ type: 'payout', payout: confirmed })
  }

  private async failPermanently(p: PayoutRow, error: string): Promise<false> {
    const [row] = await this.d.db
      .update(payouts)
      .set({ status: 'failed_permanent', error })
      .where(eq(payouts.id, p.id))
      .returning()
    this.d.alerter.notify({
      kind: 'payout.failed_permanent',
      severity: 'critical',
      message: `payout #${p.id} to ${p.wallet} can never succeed (${error}); ${p.amountRaw} raw stays in the pool`,
      immediate: true,
    })
    if (row) this.d.onEvent?.({ type: 'payout', payout: row })
    return false
  }

  private async setStatus(
    id: bigint,
    status: string,
    extra: Partial<Pick<PayoutRow, 'nextAttemptAt' | 'error' | 'sentAt'>> = {},
  ): Promise<void> {
    const [row] = await this.d.db
      .update(payouts)
      .set({ status, ...extra })
      .where(eq(payouts.id, id))
      .returning()
    if (row) this.d.onEvent?.({ type: 'payout', payout: row })
  }
}

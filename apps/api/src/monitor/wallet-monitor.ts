import {
  formatPump,
  hysteresisState,
  poolReserveRaw,
  poolSnapshot,
  scaledToDecimal,
  type EconomyConfig,
} from '@scratchy/core'
import type { AlertEvent, Alerter } from '../alerts/types'
import type { ChainClient } from '../chain/types'

/**
 * Hot-wallet monitor (PLAN §2.5): the automatic low_gas / low_pool pauses.
 *
 * Every `intervalMs` (and on demand via requestCheck(), e.g. when a payout send fails for balance
 * reasons) it reads the PRIZE wallet's SOL and PUMP (PUMP at *finalized* commitment, like the round
 * snapshot) and the CREATOR wallet's SOL, then:
 *  - lowGas  = PRIZE SOL < MIN_GAS_SOL                                          → pause payouts
 *  - lowPool = P < MIN_POOL_RESERVE_USD in PUMP at the last known price          → pause payouts
 *              where P = PRIZE PUMP − jackpot pot J − outstanding payouts (core poolSnapshot);
 *              no PUMP price ever known → fail closed (paused + critical alert)
 *  - CREATOR SOL < minCreatorGasLamports                                         → alert only
 * Pauses resume with hysteresis (resume only at ≥ threshold × (1 + hysteresis)) so a balance hovering
 * at the line doesn't flap. Every transition is alerted immediately, deduped per condition.
 *
 * Until the first successful check the state is fail-closed (lowGas = lowPool = true, checkedAt null):
 * run `await monitor.check()` at boot before starting the payout worker. A failed check (RPC down)
 * keeps the previous state and alerts. check()/start()/stop() never throw.
 */

export interface WalletMonitorOptions {
  chain: ChainClient
  prizeAddress: string
  creatorAddress: string | null
  /** the mint prizes are paid in (devnet: the mock PUMP mint) */
  pumpMint: string
  economy: EconomyConfig
  /** CREATOR fee-claim wallet gas floor (alert only) */
  minCreatorGasLamports: bigint
  /** resume margin in ppm (RESERVE_HYSTERESIS 0.10 → 100_000n) */
  hysteresisPpm: bigint
  /** last known PUMP/USD × 1e18, or null when no price has ever been known */
  getPumpUsdE18: () => bigint | null
  /** jackpot pot J and payouts owed but not yet landed (raw PUMP) */
  getReservedRaw: () => Promise<{ jackpotRaw: bigint; outstandingRaw: bigint }>
  alerter: Alerter
  intervalMs?: number
  /** decimals of the payout mint (PUMP = 6) */
  pumpDecimals?: number
  now?: () => Date
  /** called after every check that flipped lowGas or lowPool (e.g. wake the payout worker on resume) */
  onChange?: (state: WalletMonitorState) => void
}

export type LowPoolReason = 'no_price' | 'below_reserve'

export interface WalletMonitorState {
  /** PRIZE SOL below MIN_GAS_SOL (with hysteresis) → payouts paused */
  lowGas: boolean
  /** pool below MIN_POOL_RESERVE (with hysteresis) or no price ever known → payouts paused */
  lowPool: boolean
  lowPoolReason: LowPoolReason | null
  /** CREATOR SOL below its floor (alert only, never pauses) */
  creatorGasLow: boolean
  prizeSolLamports: bigint | null
  /** PRIZE PUMP balance at finalized commitment */
  prizePumpRaw: bigint | null
  jackpotRaw: bigint | null
  outstandingRaw: bigint | null
  /** P = prizePump − J − outstanding (never negative) */
  poolRaw: bigint | null
  /** MIN_POOL_RESERVE_USD in raw PUMP at the last known price (null = no price ever known) */
  reserveRaw: bigint | null
  creatorSolLamports: bigint | null
  /** last successful check (null = never → fail-closed) */
  checkedAt: Date | null
  /** error of the last check if it failed (state above is then from the previous success) */
  lastError: string | null
}

const PPM = 1_000_000n
const MAX_CHECKS_PER_RUN = 3

export class WalletMonitor {
  private readonly intervalMs: number
  private readonly decimals: number
  private readonly now: () => Date
  private st: WalletMonitorState = {
    lowGas: true,
    lowPool: true,
    lowPoolReason: null,
    creatorGasLow: false,
    prizeSolLamports: null,
    prizePumpRaw: null,
    jackpotRaw: null,
    outstandingRaw: null,
    poolRaw: null,
    reserveRaw: null,
    creatorSolLamports: null,
    checkedAt: null,
    lastError: null,
  }
  private initialized = false
  private lastReserveRaw: bigint | null = null
  private inFlight: Promise<WalletMonitorState> | null = null
  private recheck = false
  private pendingReason: string | null = null
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly o: WalletMonitorOptions) {
    this.intervalMs = Math.max(1_000, o.intervalMs ?? 30_000)
    this.decimals = o.pumpDecimals ?? 6
    this.now = o.now ?? (() => new Date())
  }

  state(): WalletMonitorState {
    return { ...this.st }
  }

  /**
   * Run a balance check. If one is already running, another is queued right after it and the returned
   * state reflects reads that started after this call. Never rejects.
   */
  check(): Promise<WalletMonitorState> {
    if (this.inFlight) {
      this.recheck = true
      return this.inFlight
    }
    this.inFlight = this.runChecks().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** out-of-band check (payout gate's onBalanceTrouble); fire-and-forget, coalesced */
  requestCheck(reason?: string): void {
    if (reason) this.pendingReason = reason.slice(0, 300)
    void this.check()
  }

  start(): void {
    if (this.running) return
    this.running = true
    const tick = (): void => {
      if (!this.running) return
      void this.check().finally(() => {
        if (!this.running) return
        this.timer = setTimeout(tick, this.intervalMs)
        this.timer.unref?.()
      })
    }
    tick()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.inFlight) await this.inFlight
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private async runChecks(): Promise<WalletMonitorState> {
    for (let i = 0; i < MAX_CHECKS_PER_RUN; i++) {
      this.recheck = false
      try {
        await this.checkOnce()
      } catch (err) {
        this.fail(err)
      }
      if (!this.recheck) break
    }
    return this.state()
  }

  private async checkOnce(): Promise<void> {
    const { chain, prizeAddress, creatorAddress, pumpMint } = this.o
    const trigger = this.pendingReason
    this.pendingReason = null
    let reads: [
      { value: bigint },
      { value: bigint },
      { value: bigint } | null,
      { jackpotRaw: bigint; outstandingRaw: bigint },
    ]
    try {
      reads = await Promise.all([
        chain.getSolBalance(prizeAddress, 'confirmed'),
        chain.getTokenBalance(prizeAddress, pumpMint, 'finalized'),
        creatorAddress ? chain.getSolBalance(creatorAddress, 'confirmed') : Promise.resolve(null),
        this.o.getReservedRaw(),
      ])
    } catch (err) {
      this.fail(err, trigger)
      return
    }
    const [prizeSol, prizePump, creatorSol, reserved] = reads
    const { economy, hysteresisPpm } = this.o

    // pool vs reserve (fail closed when no price has ever been known)
    const poolRaw = poolSnapshot({
      walletBalanceRaw: prizePump.value,
      jackpotRaw: reserved.jackpotRaw,
      outstandingRaw: reserved.outstandingRaw,
    })
    let price: bigint | null = null
    try {
      price = this.o.getPumpUsdE18()
    } catch {
      price = null
    }
    const freshReserve = poolReserveRaw(economy, price, this.decimals)
    if (freshReserve !== null) this.lastReserveRaw = freshReserve
    const reserveRaw = this.lastReserveRaw // keeps the last computed reserve if the price disappears

    const prev = {
      init: this.initialized,
      lowGas: this.st.lowGas,
      lowPool: this.st.lowPool,
      reason: this.st.lowPoolReason,
      creatorLow: this.st.creatorGasLow,
    }

    const lowGas = hysteresisState(
      prev.init && prev.lowGas,
      prizeSol.value,
      economy.minGasLamports,
      hysteresisPpm,
    )
    let lowPool: boolean
    let reason: LowPoolReason | null
    if (reserveRaw === null) {
      lowPool = true
      reason = 'no_price'
    } else {
      // a pause that was only for "no price" is re-evaluated against the plain threshold
      const wasBelow = prev.init && prev.lowPool && prev.reason === 'below_reserve'
      lowPool = hysteresisState(wasBelow, poolRaw, reserveRaw, hysteresisPpm)
      reason = lowPool ? 'below_reserve' : null
    }
    const creatorGasLow =
      creatorSol === null
        ? false
        : hysteresisState(
            prev.init && prev.creatorLow,
            creatorSol.value,
            this.o.minCreatorGasLamports,
            hysteresisPpm,
          )

    this.st = {
      lowGas,
      lowPool,
      lowPoolReason: reason,
      creatorGasLow,
      prizeSolLamports: prizeSol.value,
      prizePumpRaw: prizePump.value,
      jackpotRaw: reserved.jackpotRaw,
      outstandingRaw: reserved.outstandingRaw,
      poolRaw,
      reserveRaw,
      creatorSolLamports: creatorSol?.value ?? null,
      checkedAt: this.now(),
      lastError: null,
    }
    this.initialized = true

    // ── transitions → alerts (from the unknown boot state only problems are reported) ──
    const extra = trigger ? { trigger } : {}
    if (lowGas && (!prev.init || !prev.lowGas)) this.emit(this.lowGasPaused(extra))
    else if (!lowGas && prev.init && prev.lowGas) this.emit(this.lowGasResumed(extra))

    if (lowPool && (!prev.init || !prev.lowPool || prev.reason !== reason))
      this.emit(this.lowPoolPaused(extra))
    else if (!lowPool && prev.init && prev.lowPool) this.emit(this.lowPoolResumed(extra))

    if (creatorGasLow && (!prev.init || !prev.creatorLow)) this.emit(this.creatorLow())
    else if (!creatorGasLow && prev.init && prev.creatorLow) this.emit(this.creatorOk())

    if (!prev.init || lowGas !== prev.lowGas || lowPool !== prev.lowPool) {
      try {
        this.o.onChange?.(this.state())
      } catch {
        /* a listener must never break the monitor */
      }
    }
  }

  private fail(err: unknown, trigger: string | null = null): void {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300)
    this.st = { ...this.st, lastError: msg }
    this.emit({
      kind: 'monitor.check_failed',
      severity: 'warn',
      message: `wallet monitor: balance check failed (${msg}); keeping the previous pause state${
        this.initialized ? '' : ' (fail-closed: no successful check yet)'
      }`,
      data: { error: msg, lastCheckedAt: this.st.checkedAt, ...(trigger ? { trigger } : {}) },
      immediate: true,
      dedupeKey: 'monitor.check_failed',
    })
  }

  private emit(e: AlertEvent): void {
    try {
      this.o.alerter.notify(e)
    } catch {
      /* Alerter.notify never throws; belt and braces */
    }
  }

  private lowGasPaused(extra: Record<string, unknown>): AlertEvent {
    const min = this.o.economy.minGasLamports
    const sol = this.st.prizeSolLamports ?? 0n
    return {
      kind: 'monitor.low_gas.paused',
      severity: 'critical',
      message:
        `Payouts PAUSED (low_gas): PRIZE wallet has ${fmtSol(sol)} SOL < MIN_GAS_SOL ${fmtSol(min)} SOL ` +
        `(fees + ATA rent). Top up ${this.o.prizeAddress}; auto-resumes at ≥ ${fmtSol(this.resumeAt(min))} SOL.`,
      data: { prizeSolLamports: sol, minGasLamports: min, resumeAtLamports: this.resumeAt(min), ...extra },
      immediate: true,
      dedupeKey: 'monitor.low_gas',
    }
  }

  private lowGasResumed(extra: Record<string, unknown>): AlertEvent {
    const sol = this.st.prizeSolLamports ?? 0n
    return {
      kind: 'monitor.low_gas.resumed',
      severity: 'info',
      message: `Payouts RESUMED (gas): PRIZE wallet back to ${fmtSol(sol)} SOL.`,
      data: { prizeSolLamports: sol, minGasLamports: this.o.economy.minGasLamports, ...extra },
      immediate: true,
      dedupeKey: 'monitor.low_gas',
    }
  }

  private lowPoolPaused(extra: Record<string, unknown>): AlertEvent {
    const s = this.st
    const data = {
      prizePumpRaw: s.prizePumpRaw,
      jackpotRaw: s.jackpotRaw,
      outstandingRaw: s.outstandingRaw,
      poolRaw: s.poolRaw,
      reserveRaw: s.reserveRaw,
      minPoolReserveUsd: this.o.economy.minPoolReserveUsd,
      ...extra,
    }
    if (s.lowPoolReason === 'no_price' || s.reserveRaw === null) {
      return {
        kind: 'monitor.no_price',
        severity: 'critical',
        message:
          'Payouts PAUSED (low_pool, fail-closed): no price known for PUMP yet, so MIN_POOL_RESERVE_USD ' +
          `($${this.o.economy.minPoolReserveUsd}) can't be converted to PUMP. Resumes once the oracle has a ` +
          `price and the pool (${this.pump(s.poolRaw)} PUMP) covers the reserve.`,
        data: { ...data, reason: 'no_price' },
        immediate: true,
        dedupeKey: 'monitor.low_pool',
      }
    }
    return {
      kind: 'monitor.low_pool.paused',
      severity: 'critical',
      message:
        `Payouts PAUSED (low_pool): pool ${this.pump(s.poolRaw)} PUMP < reserve ${this.pump(s.reserveRaw)} PUMP ` +
        `($${this.o.economy.minPoolReserveUsd} at the last known price). Wallet ${this.pump(s.prizePumpRaw)} − ` +
        `jackpot ${this.pump(s.jackpotRaw)} − outstanding ${this.pump(s.outstandingRaw)}. ` +
        `Auto-resumes at ≥ ${this.pump(this.resumeAt(s.reserveRaw))} PUMP.`,
      data: { ...data, reason: 'below_reserve', resumeAtRaw: this.resumeAt(s.reserveRaw) },
      immediate: true,
      dedupeKey: 'monitor.low_pool',
    }
  }

  private lowPoolResumed(extra: Record<string, unknown>): AlertEvent {
    const s = this.st
    return {
      kind: 'monitor.low_pool.resumed',
      severity: 'info',
      message: `Payouts RESUMED (pool): ${this.pump(s.poolRaw)} PUMP ≥ reserve ${this.pump(s.reserveRaw)} PUMP.`,
      data: { poolRaw: s.poolRaw, reserveRaw: s.reserveRaw, ...extra },
      immediate: true,
      dedupeKey: 'monitor.low_pool',
    }
  }

  private creatorLow(): AlertEvent {
    const sol = this.st.creatorSolLamports ?? 0n
    const min = this.o.minCreatorGasLamports
    return {
      kind: 'monitor.creator_gas_low',
      severity: 'warn',
      message:
        `CREATOR wallet has ${fmtSol(sol)} SOL < ${fmtSol(min)} SOL — fee claims / 70-30 splits may fail. ` +
        `Top up ${this.o.creatorAddress}. (Payouts are not paused.)`,
      data: { creatorSolLamports: sol, minCreatorGasLamports: min },
      immediate: true,
      dedupeKey: 'monitor.creator_gas',
    }
  }

  private creatorOk(): AlertEvent {
    const sol = this.st.creatorSolLamports ?? 0n
    return {
      kind: 'monitor.creator_gas_ok',
      severity: 'info',
      message: `CREATOR wallet gas back to ${fmtSol(sol)} SOL.`,
      data: { creatorSolLamports: sol, minCreatorGasLamports: this.o.minCreatorGasLamports },
      immediate: true,
      dedupeKey: 'monitor.creator_gas',
    }
  }

  private resumeAt(threshold: bigint): bigint {
    return threshold + (threshold * this.o.hysteresisPpm) / PPM
  }

  private pump(raw: bigint | null): string {
    return raw === null ? '?' : formatPump(raw, this.decimals)
  }
}

function fmtSol(lamports: bigint): string {
  return scaledToDecimal(lamports, 9)
}

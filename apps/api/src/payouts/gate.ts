import type { PauseRegistry } from '../engine/pauses'
import type { WalletMonitor } from '../monitor/wallet-monitor'
import type { GateHold, PayoutGate } from './worker'

/**
 * The payout worker's single question: may a NEW transfer be built right now?
 * Hard pauses (manual / breaker_mismatch / invariant / mint_changed / payouts_stuck — DB-synced across
 * processes) first; then the monitor's self-clearing low_gas / low_pool. Per-round breaker holds are handled on
 * the payout rows themselves.
 */
export class PayoutGateImpl implements PayoutGate {
  constructor(
    private readonly pauses: PauseRegistry,
    private readonly monitor: WalletMonitor,
  ) {}

  hold(): GateHold | null {
    const hard = this.pauses.first()
    if (hard) return { reason: hard, hard: true }
    const s = this.monitor.state()
    if (s.lowGas) return { reason: 'low_gas', hard: false }
    if (s.lowPool) return { reason: 'low_pool', hard: false }
    return null
  }

  onBalanceTrouble(kind: 'low_gas' | 'low_pool', detail: string): void {
    this.monitor.requestCheck(`${kind}: ${detail}`)
  }

  onStuck(detail: string): void {
    void this.pauses.set('payouts_stuck', detail)
  }

  onDoublePay(detail: string): void {
    void this.pauses.set('invariant', detail)
  }
}

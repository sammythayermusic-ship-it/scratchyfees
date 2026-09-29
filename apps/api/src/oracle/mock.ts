import { decimalToScaled } from '@scratchy/core'
import type { UsdPriceSource } from './types'

/**
 * Fixed PUMP/USD for devnet and `CHAIN_MODE=memory` (PRICE_SOURCE=mock, MOCK_PUMP_USD). The devnet mock
 * PUMP mint has no market, so the "~$" display and the $50 eligibility tiers run off this constant.
 * Tests can move the price or simulate an outage with setPrice / setFailing.
 */
export class MockUsdSource implements UsdPriceSource {
  readonly name: string
  private priceE18: bigint | null
  private failing: Error | null = null
  /** number of fetchUsdPriceE18 calls (tests assert caching / single-flight with it) */
  calls = 0

  constructor(price: string, name = 'mock') {
    this.name = name
    this.priceE18 = parsePrice(price)
  }

  /** a decimal USD price, or null for "no reliable price" */
  setPrice(price: string | null): void {
    this.priceE18 = price === null ? null : parsePrice(price)
  }

  /** make every fetch throw (true / custom error) or succeed again (false) */
  setFailing(fail: boolean | Error): void {
    this.failing = fail === false ? null : fail === true ? new Error(`${this.name}: simulated outage`) : fail
  }

  async fetchUsdPriceE18(_mint: string): Promise<bigint | null> {
    this.calls++
    if (this.failing) throw this.failing
    return this.priceE18
  }
}

function parsePrice(price: string): bigint {
  const v = decimalToScaled(price, 18)
  if (v <= 0n) throw new RangeError(`mock USD price must be > 0 (got "${price}")`)
  return v
}

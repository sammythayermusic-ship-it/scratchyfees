import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { prices } from '../db/schema'
import type { PriceQuote } from './types'

/**
 * Persistence for the last live prices (PLAN §3 "freeze eligibility at last known price"): every live
 * value the oracle obtains is saved, and loaded again at startup — so a restart in the middle of a price
 * outage comes back 'frozen' at the last known price instead of 'none' (which would fail closed).
 */
export interface PricesStore {
  /** every persisted quote by key */
  load(): Promise<Map<string, PriceQuote>>
  /** upsert; a quote older than the stored one never overwrites it */
  save(key: string, quote: PriceQuote): Promise<void>
}

/** Postgres-backed store over the `prices` table (value_e18 is a decimal string of the bigint). */
export class DbPricesStore implements PricesStore {
  constructor(private readonly db: Db) {}

  async load(): Promise<Map<string, PriceQuote>> {
    const rows = await this.db.select().from(prices)
    const out = new Map<string, PriceQuote>()
    for (const row of rows) {
      let valueE18: bigint
      try {
        valueE18 = BigInt(row.valueE18)
      } catch {
        continue // a corrupt row must never block startup
      }
      if (valueE18 <= 0n) continue
      out.set(row.key, { valueE18, source: row.source, at: row.at })
    }
    return out
  }

  async save(key: string, quote: PriceQuote): Promise<void> {
    await this.db
      .insert(prices)
      .values({ key, valueE18: quote.valueE18.toString(), source: quote.source, at: quote.at })
      .onConflictDoUpdate({
        target: prices.key,
        set: { valueE18: sql`excluded.value_e18`, source: sql`excluded.source`, at: sql`excluded.at` },
        setWhere: sql`${prices.at} <= excluded.at`,
      })
  }
}

/** In-process store for tests and `CHAIN_MODE=memory`. */
export class MemoryPricesStore implements PricesStore {
  private readonly quotes = new Map<string, PriceQuote>()
  /** number of save() calls */
  saves = 0

  constructor(initial?: Iterable<readonly [string, PriceQuote]>) {
    for (const [k, q] of initial ?? []) this.quotes.set(k, { ...q })
  }

  async load(): Promise<Map<string, PriceQuote>> {
    return new Map([...this.quotes].map(([k, q]) => [k, { ...q }]))
  }

  async save(key: string, quote: PriceQuote): Promise<void> {
    this.saves++
    const prev = this.quotes.get(key)
    if (prev && prev.at.getTime() > quote.at.getTime()) return
    this.quotes.set(key, { ...quote })
  }

  get(key: string): PriceQuote | undefined {
    const q = this.quotes.get(key)
    return q ? { ...q } : undefined
  }
}

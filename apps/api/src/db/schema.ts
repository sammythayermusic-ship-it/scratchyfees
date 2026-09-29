import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/**
 * PLAN.md §3.1 tables (+ the ledger/attempt tables the exactly-once payout design needs).
 * Every PUMP amount is a bigint of raw base units (the spec's `*_lamports` columns → `*_raw`).
 */

const raw = (name: string) => bigint(name, { mode: 'bigint' })
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const wallets = pgTable('wallets', {
  address: text('address').primaryKey(),
  xHandle: text('x_handle'),
  firstSeen: ts('first_seen').notNull().defaultNow(),
  totalWonRaw: raw('total_won_raw')
    .notNull()
    .default(sql`0`),
  /** last paste / lock-holder heartbeat — Decision C: activity in round N enters round N+1 */
  lastActiveAt: ts('last_active_at'),
  /** Decision D bookkeeping: how many times the hot wallet paid this wallet's PUMP account rent */
  ataCreatedCount: integer('ata_created_count').notNull().default(0),
  /** REQUIRE_HOLD_ONE_ROUND (off at launch): first time an eligible balance was observed */
  eligibleSince: ts('eligible_since'),
})

export const rounds = pgTable(
  'rounds',
  {
    /** the integer roundId used in the provably-fair message */
    id: serial('id').primaryKey(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    /** pending (seed committed, not started) | live | ended | skipped */
    status: text('status').notNull(),
    /** why a round issued no tickets (paused / no entrants / low pool) */
    skipReason: text('skip_reason'),
    serverSeedHash: text('server_seed_hash').notNull(),
    /** NULL until revealed at round end (secret lives in round_secrets meanwhile) */
    serverSeed: text('server_seed'),

    // snapshot + parameters (the round stores its own params so old rounds always verify)
    walletBalanceRaw: raw('wallet_balance_raw'),
    outstandingRaw: raw('outstanding_raw'),
    snapshotSlot: raw('snapshot_slot'),
    poolRaw: raw('pool_raw'),
    budgetRaw: raw('budget_raw'),
    ticketBudgetRaw: raw('ticket_budget_raw'),
    jackpotAccrualRaw: raw('jackpot_accrual_raw'),
    jackpotAfterRaw: raw('jackpot_after_raw'),
    singlePrizeCapRaw: raw('single_prize_cap_raw'),
    breakerLimitRaw: raw('breaker_limit_raw'),
    payoutRatePpm: raw('payout_rate_ppm'),
    jackpotSharePpm: raw('jackpot_share_ppm'),
    singlePrizeCapPpm: raw('single_prize_cap_ppm'),
    roundBreakerPpm: raw('round_breaker_ppm'),
    jackpotOdds: raw('jackpot_odds'),
    totalWeightedMicro: raw('total_weighted_micro'),
    entrantCount: integer('entrant_count').notNull().default(0),
    ticketCount: integer('ticket_count').notNull().default(0),
    /** prices at the snapshot (USD per whole token × 1e18, as decimal strings) */
    pumpUsdE18: text('pump_usd_e18'),
    scratchyUsdE18: text('scratchy_usd_e18'),
    priceState: text('price_state'),

    // realized results
    realizedRaw: raw('realized_raw')
      .notNull()
      .default(sql`0`),
    breakerTripped: boolean('breaker_tripped').notNull().default(false),
    /** Decision E: null | ok | mismatch */
    breakerVerified: text('breaker_verified'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('rounds_status_idx').on(t.status), uniqueIndex('rounds_starts_at_uq').on(t.startsAt)],
)

export const roundSecrets = pgTable('round_secrets', {
  roundId: integer('round_id')
    .primaryKey()
    .references(() => rounds.id),
  serverSeed: text('server_seed').notNull(),
})

export const entries = pgTable(
  'entries',
  {
    roundId: integer('round_id')
      .notNull()
      .references(() => rounds.id),
    wallet: text('wallet').notNull(),
    holdingsRaw: raw('holdings_raw').notNull(),
    holdingsUsdMicro: raw('holdings_usd_micro').notNull(),
    tickets: integer('tickets').notNull(),
    multMicro: raw('mult_micro').notNull(),
    weightedMicro: raw('weighted_micro').notNull(),
    /** §3.2 one scratching session per wallet per round */
    sessionId: text('session_id'),
    lockExpiresAt: ts('lock_expires_at'),
    voidedAt: ts('voided_at'),
    voidReason: text('void_reason'),
  },
  (t) => [primaryKey({ columns: [t.roundId, t.wallet] })],
)

export const tickets = pgTable(
  'tickets',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    roundId: integer('round_id')
      .notNull()
      .references(() => rounds.id),
    wallet: text('wallet').notNull(),
    idx: integer('idx').notNull(),
    tier: smallint('tier').notNull(),
    jackpot: boolean('jackpot').notNull().default(false),
    prizeRaw: raw('prize_raw').notNull(),
    /** set at reveal when a jackpot roll takes the pot */
    jackpotPrizeRaw: raw('jackpot_prize_raw')
      .notNull()
      .default(sql`0`),
    scratchedAt: ts('scratched_at'),
    void: boolean('void').notNull().default(false),
    payoutId: bigint('payout_id', { mode: 'bigint' }),
    jackpotPayoutId: bigint('jackpot_payout_id', { mode: 'bigint' }),
  },
  (t) => [
    uniqueIndex('tickets_round_wallet_idx_uq').on(t.roundId, t.wallet, t.idx),
    index('tickets_round_wallet_idx').on(t.roundId, t.wallet),
  ],
)

/**
 * status: queued | held | sending | confirmed | failed | failed_permanent
 *  queued   — won, not yet attempted (or waiting out a global pause)
 *  held     — breaker hold for this round (Decision E) — released by the boundary verification
 *  sending  — an attempt is in flight; its outcome is not yet proven (the site shows "confirming…")
 *  failed   — every attempt of a cycle PROVABLY did not land → auto-retry queue (next_attempt_at)
 *  failed_permanent — deterministic error (e.g. frozen account); funds stay in the pool; alerted
 * (§3.1's queued|sent|confirmed|failed map onto these; see docs/ECONOMY.md)
 */
export const payouts = pgTable(
  'payouts',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    /** tier | jackpot (prizes, signed by PRIZE) · sweep_prize | sweep_ops (70/30 split, signed by CREATOR) */
    kind: text('kind').notNull(),
    /** prize | creator — which server key signs this outbound transfer */
    signer: text('signer').notNull().default('prize'),
    sweepId: bigint('sweep_id', { mode: 'bigint' }),
    /** recipient address */
    wallet: text('wallet').notNull(),
    amountRaw: raw('amount_raw').notNull(),
    roundId: integer('round_id').notNull(),
    status: text('status').notNull(),
    heldReason: text('held_reason'),
    txSig: text('tx_sig'),
    landedSlot: raw('landed_slot'),
    ataCreated: boolean('ata_created'),
    rebuilds: integer('rebuilds').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: ts('lease_expires_at'),
    error: text('error'),
    /** PUMP/USD × 1e18 at reveal time — only for the "~$" shown next to the exact PUMP amount */
    pumpUsdE18: text('pump_usd_e18'),
    createdAt: ts('created_at').notNull().defaultNow(),
    sentAt: ts('sent_at'),
    confirmedAt: ts('confirmed_at'),
  },
  (t) => [
    index('payouts_status_idx').on(t.status, t.nextAttemptAt),
    index('payouts_wallet_idx').on(t.wallet),
    index('payouts_round_idx').on(t.roundId),
  ],
)

/** Every signed attempt, persisted BEFORE it is sent (exactly-once protocol). */
export const payoutAttempts = pgTable(
  'payout_attempts',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    payoutId: bigint('payout_id', { mode: 'bigint' })
      .notNull()
      .references(() => payouts.id),
    attempt: integer('attempt').notNull(),
    signature: text('signature').notNull(),
    txBase64: text('tx_base64').notNull(),
    blockhash: text('blockhash').notNull(),
    lastValidBlockHeight: raw('last_valid_block_height').notNull(),
    /** built while the recipient's PUMP account was missing (this attempt pays the rent) */
    createsAta: boolean('creates_ata').notNull().default(false),
    /** pending | landed | failed_onchain | expired */
    status: text('status').notNull(),
    landedSlot: raw('landed_slot'),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSentAt: ts('last_sent_at'),
  },
  (t) => [
    uniqueIndex('payout_attempts_sig_uq').on(t.signature),
    index('payout_attempts_payout_idx').on(t.payoutId),
  ],
)

/** The progressive jackpot pot J (single row, id = 1), updated under row lock. */
export const jackpot = pgTable('jackpot', {
  id: integer('id').primaryKey(),
  amountRaw: raw('amount_raw').notNull(),
  seeded: boolean('seeded').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

/** Ledger of PRIZE-wallet PUMP movements; Σ amount = expected balance (reconciler compares to chain). */
export const prizeLedger = pgTable(
  'prize_ledger',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    /** deposit | sweep_in | payout_out | external_in */
    kind: text('kind').notNull(),
    /** signed: inflows positive, outflows negative */
    amountRaw: raw('amount_raw').notNull(),
    ref: text('ref'),
    slot: raw('slot'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('prize_ledger_kind_ref_uq').on(t.kind, t.ref)],
)

/**
 * §3.1 sweeps: claim → (swap) → split 70/30, each step ledgered and resumable.
 * status: claimed | swapped | split | done | failed
 */
export const sweeps = pgTable('sweeps', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  status: text('status').notNull(),
  claimedPumpRaw: raw('claimed_pump_raw')
    .notNull()
    .default(sql`0`),
  claimedScratchyRaw: raw('claimed_scratchy_raw')
    .notNull()
    .default(sql`0`),
  swapInScratchyRaw: raw('swap_in_scratchy_raw')
    .notNull()
    .default(sql`0`),
  swapOutPumpRaw: raw('swap_out_pump_raw')
    .notNull()
    .default(sql`0`),
  totalPumpRaw: raw('total_pump_raw')
    .notNull()
    .default(sql`0`),
  toPrizeRaw: raw('to_prize_raw')
    .notNull()
    .default(sql`0`),
  toOpsRaw: raw('to_ops_raw')
    .notNull()
    .default(sql`0`),
  txSigs: jsonb('tx_sigs')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  error: text('error'),
  at: ts('at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

/** §3.1 config (key, value) — admin-adjustable knobs and pause flags; overrides env from the next round. */
export const config = pgTable('config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

/** Breaker events, pauses/resumes, sweeps, alerts — the ops log mirrored to Telegram. */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    message: text('message').notNull(),
    data: jsonb('data'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('events_kind_idx').on(t.kind, t.at)],
)

/** Last known prices (persisted so eligibility can freeze at the last price after restarts). */
export const prices = pgTable('prices', {
  key: text('key').primaryKey(),
  valueE18: text('value_e18').notNull(),
  source: text('source').notNull(),
  at: ts('at').notNull(),
})

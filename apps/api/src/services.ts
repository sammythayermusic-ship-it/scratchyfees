import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { decimalToScaled } from '@scratchy/core'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { createAlerter } from './alerts'
import { DbEventsSink } from './alerts/events-sink'
import type { TelegramAlerter } from './alerts/telegram'
import { MemoryChainClient } from './chain/memory'
import { keypairFromEnv } from './chain/keys'
import { SolanaChainClient } from './chain/solana'
import type { ChainClient } from './chain/types'
import { createDatabase, runMigrations, type Database } from './db/client'
import { LOCK_KEYS, tryAdvisoryLock } from './db/lock'
import { config as configTable } from './db/schema'
import { eq, sql } from 'drizzle-orm'
import { isValidPublicKey } from './chain/address'
import { reservedRaw } from './db/queries'
import { EntryService } from './engine/entries'
import { EventBus } from './engine/events'
import { PauseRegistry } from './engine/pauses'
import { Reconciler } from './engine/reconciler'
import { RoundEngine } from './engine/rounds'
import { ScratchService } from './engine/scratch'
import type { AppConfig } from './env'
import { WalletMonitor } from './monitor/wallet-monitor'
import { createUsdSources, poolPriceFromVenue, PriceOracleImpl } from './oracle/oracle'
import { DbPricesStore } from './oracle/store'
import { PayoutGateImpl } from './payouts/gate'
import { PayoutWorker, type PayoutEvent } from './payouts/worker'
import { FeeSweeper } from './sweeper/sweeper'
import { DammV2Venue } from './venue/damm-v2'
import { MemorySwap, MemoryVenue } from './venue/memory'
import { DammPoolSwap } from './venue/swap-damm'
import { JupiterSwap } from './venue/swap-jupiter'
import { NoSwap } from './venue/swap-none'
import type { SwapAdapter, VenueAdapter } from './venue/types'

/**
 * Composition root: builds every backend service from the validated config.
 *   CHAIN_MODE=memory  → in-process chain + pool with a simulated market (zero keys, local dev/tests)
 *   CHAIN_MODE=solana  → devnet / mainnet via RPC (keys from env, cluster verified by genesis hash)
 * The API server, the round engine, the devnet smoke script and the rehearsal all start from here.
 */

export interface Services {
  config: AppConfig
  database: Database
  chain: ChainClient
  alerter: TelegramAlerter
  venue: VenueAdapter
  swap: SwapAdapter
  oracle: PriceOracleImpl
  monitor: WalletMonitor
  pauses: PauseRegistry
  worker: PayoutWorker
  sweeper: FeeSweeper | null
  bus: EventBus
  engine: RoundEngine
  scratch: ScratchService
  entries: EntryService
  reconciler: Reconciler
  /** mint prizes are paid in (devnet: mock PUMP) */
  pumpMint: string
  scratchyMint: string
  prizeAddress: string
  creatorAddress: string | null
  opsAddress: string | null
  /** addresses that can never enter (our wallets, pool, vaults, burn) */
  excludedWallets: Set<string>
  /** memory mode only: the in-process chain/pool for dev helpers */
  memory: MemoryWorld | null
  /** subscribe to payout status changes (websocket feed) */
  onPayout(listener: (e: PayoutEvent) => void): () => void
  /** record the payout mint's current extensions/hook as reviewed (admin resume of a mint_changed pause) */
  acknowledgeMint(): Promise<void>
  /** the accepted (acknowledged) payout-mint fingerprint vs the current one — for reviewing a mint_changed pause */
  mintState(): Promise<{ accepted: string | null; current: string | null; error?: string }>
  start(): void
  stop(): Promise<void>
}

export interface MemoryWorld {
  chain: MemoryChainClient
  venue: MemoryVenue
  /** give a pasted wallet some SCRATCHY the first time it is seen (dev only) */
  faucet(wallet: string): Promise<void>
  /** simulated trading so fees accrue and the sweeper has something to claim */
  startMarket(): void
}

const INCINERATOR = '1nc1nerator11111111111111111111111111111111'
const SYSTEM_PROGRAM = '11111111111111111111111111111111'

/** Deterministic dev address from a label (valid on-curve pubkey, no secret material used anywhere). */
export function devAddress(label: string): string {
  return Keypair.fromSeed(sha256(utf8ToBytes(`scratchy-memory:${label}`))).publicKey.toBase58()
}

export interface BuildOptions {
  /** run migrations at boot (default true) */
  migrate?: boolean
  /** override the database (tests) */
  database?: Database
  /** injectable clock for the engine/scratch/entry services (tests) */
  now?: () => Date
}

export async function buildServices(config: AppConfig, opts: BuildOptions = {}): Promise<Services> {
  const { env, economy } = config
  const database = opts.database ?? createDatabase(env.DATABASE_URL)
  if (opts.migrate !== false) await runMigrations(database.db)
  const db = database.db
  // The in-memory chain starts fresh on every boot, so rows describing a previous boot's chain (ledger, payouts,
  // rounds) would contradict it — the reconciler would rightly see "missing" PRIZE funds and hard-stop payouts.
  // Memory mode is dev/tests only (production requires CHAIN_MODE=solana), so start from a clean database.
  // Tests pass their own freshly truncated database.
  if (env.CHAIN_MODE === 'memory' && !opts.database && env.NODE_ENV !== 'production') {
    await db.execute(sql`
      DO $$ DECLARE r record; BEGIN
        FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '__drizzle%' LOOP
          EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
        END LOOP;
      END $$;`)
  }
  const alerter = createAlerter(env, new DbEventsSink(db))
  const pauses = new PauseRegistry(db, alerter)
  await pauses.load()

  let chain: ChainClient
  let venue: VenueAdapter
  let swap: SwapAdapter
  let memory: MemoryWorld | null = null
  let prizeAddress: string
  let creatorAddress: string | null
  let opsAddress: string | null
  const pumpMint = env.PUMP_MINT
  let scratchyMint: string

  if (env.CHAIN_MODE === 'memory') {
    prizeAddress = env.PRIZE_WALLET_ADDRESS ?? devAddress('prize')
    creatorAddress = env.CREATOR_WALLET_ADDRESS ?? devAddress('creator')
    opsAddress = env.OPS_WALLET_ADDRESS ?? devAddress('ops')
    scratchyMint = env.SCRATCHY_MINT ?? devAddress('scratchy-mint')
    memory = buildMemoryWorld({
      prizeAddress,
      creatorAddress,
      pumpMint,
      scratchyMint,
      mockPumpUsd: env.MOCK_PUMP_USD,
    })
    chain = memory.chain
    venue = memory.venue
    swap =
      env.SWAP === 'memory'
        ? new MemorySwap(memory.venue, memory.chain, creatorAddress, scratchyMint, pumpMint)
        : new NoSwap()
  } else {
    if (!env.PRIZE_WALLET_KEY || !env.PRIZE_WALLET_ADDRESS) {
      throw new Error('CHAIN_MODE=solana needs PRIZE_WALLET_KEY and PRIZE_WALLET_ADDRESS')
    }
    if (!env.SCRATCHY_MINT) throw new Error('CHAIN_MODE=solana needs SCRATCHY_MINT')
    scratchyMint = env.SCRATCHY_MINT
    const connection = new Connection(env.RPC_URL, {
      commitment: 'confirmed',
      ...(env.RPC_WS_URL ? { wsEndpoint: env.RPC_WS_URL } : {}),
      // every RPC call is bounded, so no single payout step can outlive its lease
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
    })
    const prize = keypairFromEnv(env.PRIZE_WALLET_KEY, env.PRIZE_WALLET_ADDRESS, 'PRIZE')
    const creator =
      env.CREATOR_WALLET_KEY && env.CREATOR_WALLET_ADDRESS
        ? keypairFromEnv(env.CREATOR_WALLET_KEY, env.CREATOR_WALLET_ADDRESS, 'CREATOR')
        : null
    if (creator && creator.publicKey.equals(prize.publicKey)) {
      throw new Error('CREATOR and PRIZE must be different wallets')
    }
    prizeAddress = prize.publicKey.toBase58()
    creatorAddress = creator?.publicKey.toBase58() ?? null
    opsAddress = env.OPS_WALLET_ADDRESS ?? null
    const solana = new SolanaChainClient({
      connection,
      cluster: env.SOLANA_CLUSTER,
      prize,
      creator,
      fallbackPriorityFeeMicroLamports: env.PRIORITY_FEE_MICROLAMPORTS,
    })
    await solana.verifyCluster()
    chain = solana

    // refuse mints whose extensions change transfer semantics; alert if a transfer hook is ever set
    const mintInfo = await chain.getMintInfo(pumpMint)
    if (mintInfo.blockingExtensions.length > 0) {
      throw new Error(
        `payout mint ${pumpMint} has blocking extensions: ${mintInfo.blockingExtensions.join(', ')}`,
      )
    }
    if (mintInfo.transferHookProgram) {
      alerter.notify({
        kind: 'mint.transfer_hook',
        severity: 'warn',
        message: `payout mint has an active transfer hook program ${mintInfo.transferHookProgram} — payouts use the hook-aware transfer`,
        immediate: true,
        dedupeKey: 'mint.transfer_hook',
      })
    }

    if (env.VENUE === 'damm-v2') {
      if (!creator || !env.VENUE_POOL_ADDRESS || !env.VENUE_POSITION_ADDRESS) {
        throw new Error(
          'VENUE=damm-v2 needs CREATOR_WALLET_KEY/ADDRESS, VENUE_POOL_ADDRESS, VENUE_POSITION_ADDRESS',
        )
      }
      const damm = await DammV2Venue.create({
        connection,
        creator,
        pool: new PublicKey(env.VENUE_POOL_ADDRESS),
        position: new PublicKey(env.VENUE_POSITION_ADDRESS),
        baseMint: new PublicKey(scratchyMint),
        quoteMint: new PublicKey(pumpMint),
      })
      // Launch config: fees accrue ONLY in PUMP (collectFeeMode = OnlyB with PUMP as token B). A pool created
      // the other way round would pile fees up in SCRATCHY, which never reaches the prize pool without a swap.
      const fees = await damm.feeCollection()
      if (fees !== 'quote-only') {
        const msg = `venue pool ${env.VENUE_POOL_ADDRESS} collects fees in ${fees === 'both' ? 'BOTH tokens' : 'SCRATCHY only'}, not PUMP only`
        if (env.SWAP === 'none')
          throw new Error(
            `${msg} — with SWAP=none the SCRATCHY part could never be paid out; fix the pool or set SWAP`,
          )
        alerter.notify({
          kind: 'venue.fee_mode',
          severity: 'warn',
          message: `${msg}; SCRATCHY fees are swapped via SWAP=${env.SWAP}`,
          immediate: true,
        })
      }
      venue = damm
    } else {
      throw new Error('CHAIN_MODE=solana requires VENUE=damm-v2')
    }

    if (env.SWAP === 'damm-v2') {
      if (!creator) throw new Error('SWAP=damm-v2 needs the CREATOR key')
      swap = new DammPoolSwap({
        connection,
        owner: creator,
        pool: new PublicKey(env.SWAP_POOL_ADDRESS ?? env.VENUE_POOL_ADDRESS),
        baseMint: new PublicKey(scratchyMint),
        quoteMint: new PublicKey(pumpMint),
      })
    } else if (env.SWAP === 'jupiter') {
      if (!creator) throw new Error('SWAP=jupiter needs the CREATOR key')
      swap = new JupiterSwap({
        connection,
        owner: creator,
        base: env.JUPITER_API_BASE,
        apiKey: env.JUPITER_API_KEY,
        inputMint: scratchyMint,
        outputMint: pumpMint,
      })
    } else {
      swap = new NoSwap()
    }
  }

  const excludedWallets = new Set<string>([
    prizeAddress,
    ...(creatorAddress ? [creatorAddress] : []),
    ...(opsAddress ? [opsAddress] : []),
    ...venue.excludedAddresses(),
    ...env.EXCLUDED_WALLETS,
    INCINERATOR,
    SYSTEM_PROGRAM,
  ])

  const oracle = new PriceOracleImpl({
    pumpMint: env.PUMP_PRICE_MINT,
    sources: createUsdSources(env),
    poolPrice: poolPriceFromVenue(venue),
    cacheSeconds: economy.priceCacheSeconds,
    store: new DbPricesStore(db),
    alerter,
    scratchyPumpKey: `scratchy_pump:${env.VENUE_POOL_ADDRESS ?? 'memory'}`,
  })
  await oracle.init()

  const hysteresisPpm = decimalToScaled(env.RESERVE_HYSTERESIS, 6)
  const listeners = new Set<(e: PayoutEvent) => void>()
  let worker: PayoutWorker | null = null
  const monitor = new WalletMonitor({
    chain,
    prizeAddress,
    creatorAddress,
    pumpMint,
    economy,
    minCreatorGasLamports: decimalToScaled(env.MIN_CREATOR_GAS_SOL, 9),
    hysteresisPpm,
    getPumpUsdE18: () => oracle.peek().pumpUsd?.valueE18 ?? null,
    getReservedRaw: (slot) => reservedRaw(db, slot),
    alerter,
    onChange: () => worker?.wake(),
  })

  const gate = new PayoutGateImpl(pauses, monitor)
  worker = new PayoutWorker({
    db,
    chain,
    alerter,
    gate,
    mint: pumpMint,
    deployId: env.DEPLOY_ID,
    concurrency: env.PAYOUT_CONCURRENCY,
    priorityFeeCapMicroLamports: env.PRIORITY_FEE_MAX_MICROLAMPORTS,
    ataRecreateLimit: env.ATA_RECREATE_LIMIT,
    onEvent: (e) => {
      for (const l of listeners) l(e)
    },
  })
  const payoutWorker = worker

  if (env.SWEEPER_ENABLED) {
    if (!creatorAddress || !opsAddress) {
      alerter.notify({
        kind: 'sweep.disabled',
        severity: env.CHAIN_MODE === 'solana' ? 'critical' : 'info',
        message: 'fee sweeper disabled: CREATOR key/address and OPS_WALLET_ADDRESS are required',
        immediate: true,
      })
    } else if (!isValidPublicKey(opsAddress) && env.CHAIN_MODE === 'solana') {
      throw new Error('OPS_WALLET_ADDRESS is not a valid Solana address')
    } else if (opsAddress === prizeAddress || opsAddress === creatorAddress) {
      throw new Error('OPS_WALLET_ADDRESS must differ from the PRIZE and CREATOR wallets')
    }
  }
  const sweeper =
    env.SWEEPER_ENABLED && creatorAddress && opsAddress
      ? new FeeSweeper({
          db,
          chain,
          venue,
          swap,
          alerter,
          economy,
          creatorAddress,
          prizeAddress,
          opsAddress,
          quoteMint: pumpMint,
          baseMint: scratchyMint,
          maxSlippageBps: env.SWEEP_MAX_SLIPPAGE_BPS,
          onQueued: () => payoutWorker.wake(),
        })
      : null

  const bus = new EventBus()
  // payout status changes flow onto the same bus as everything else (websocket feed)
  listeners.add((e) =>
    bus.emit({
      type: 'payout',
      payoutId: e.payout.id.toString(),
      wallet: e.payout.wallet,
      kind: e.payout.kind,
      status: e.payout.status,
      amountRaw: e.payout.amountRaw.toString(),
      txSig: e.payout.txSig,
    }),
  )
  const engine = new RoundEngine({
    db,
    pool: database.pool,
    chain,
    oracle,
    monitor,
    pauses,
    alerter,
    bus,
    economy,
    prizeAddress,
    pumpMint,
    scratchyMint,
    excludedWallets,
    requireHoldOneRound: env.REQUIRE_HOLD_ONE_ROUND,
    wakeWorker: () => payoutWorker.wake(),
    devForceJackpotWallet:
      env.DEV_FORCE_JACKPOT && env.SOLANA_CLUSTER !== 'mainnet-beta'
        ? (env.DEV_FORCE_JACKPOT_WALLET ?? null)
        : null,
    devForceJackpotRound: env.DEV_FORCE_JACKPOT_ROUND || null,
    devForceBreakerRound: env.SOLANA_CLUSTER !== 'mainnet-beta' ? env.DEV_FORCE_BREAKER_ROUND || null : null,
    now: opts.now,
  })
  const scratch = new ScratchService({
    db,
    chain,
    oracle,
    bus,
    alerter,
    economy,
    scratchyMint,
    holdingsCacheSeconds: env.HOLDINGS_CACHE_SECONDS,
    sessionLockSeconds: env.SESSION_LOCK_SECONDS,
    wakeWorker: () => payoutWorker.wake(),
    now: opts.now,
  })
  const entryService = new EntryService({
    db,
    chain,
    oracle,
    economy,
    scratchyMint,
    excludedWallets,
    maxWalletsPerIpPerRound: env.MAX_WALLETS_PER_IP_PER_ROUND,
    sessionLockSeconds: env.SESSION_LOCK_SECONDS,
    beforeEnter: memory ? (w) => memory!.faucet(w) : undefined,
    outcomesFor: (rows) => scratch.outcomesFor(rows),
    now: opts.now,
  })

  const reconciler = new Reconciler({ db, chain, prizeAddress, pumpMint, pauses, alerter })

  let sweepTimer: NodeJS.Timeout | null = null
  let sweeping: Promise<void> | null = null
  let mintTimer: NodeJS.Timeout | null = null

  /** Payout-mint watch (review SOL-2): any change to its extensions / transfer hook → hard pause until reviewed. */
  const mintFingerprint = async () => {
    const m = await chain.getMintInfo(pumpMint)
    return JSON.stringify({
      program: m.tokenProgram,
      ext: [...m.extensions].sort(),
      hook: m.transferHookProgram,
      block: m.blockingExtensions,
    })
  }
  const mintState = async () => {
    const [ack] = await db.select().from(configTable).where(eq(configTable.key, 'mint.ack'))
    try {
      return { accepted: ack?.value ?? null, current: await mintFingerprint() }
    } catch (e) {
      return { accepted: ack?.value ?? null, current: null, error: (e as Error).message }
    }
  }
  const acknowledgeMint = async () => {
    const fp = await mintFingerprint()
    await db
      .insert(configTable)
      .values({ key: 'mint.ack', value: fp })
      .onConflictDoUpdate({ target: configTable.key, set: { value: fp, updatedAt: new Date() } })
  }
  const checkMint = async () => {
    try {
      const fp = await mintFingerprint()
      const [ack] = await db.select().from(configTable).where(eq(configTable.key, 'mint.ack'))
      if (!ack) {
        const initialHook = JSON.parse(fp).hook as string | null
        if (initialHook)
          await pauses.set(
            'mint_changed',
            `payout mint has an active transfer hook (${initialHook}) — review, then resume`,
          )
        await db.insert(configTable).values({ key: 'mint.ack', value: fp }).onConflictDoNothing()
      } else if (ack.value !== fp && !pauses.list().some((p) => p.reason === 'mint_changed')) {
        await pauses.set(
          'mint_changed',
          `payout mint changed: ${fp} (was ${ack.value}) — review, then resume from the admin panel`,
        )
      }
    } catch {
      /* next check */
    }
  }

  return {
    acknowledgeMint,
    mintState,
    config,
    database,
    chain,
    alerter,
    venue,
    swap,
    oracle,
    monitor,
    pauses,
    worker: payoutWorker,
    sweeper,
    bus,
    engine,
    scratch,
    entries: entryService,
    reconciler,
    pumpMint,
    scratchyMint,
    prizeAddress,
    creatorAddress,
    opsAddress,
    excludedWallets,
    memory,
    onPayout(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start() {
      pauses.startSync()
      void checkMint()
      mintTimer = setInterval(() => void checkMint(), 60_000)
      mintTimer.unref()
      oracle.start()
      monitor.start()
      // the monitor fails closed (no_price) until a price is known — re-check as soon as the first fetch lands
      void oracle.get().finally(() => monitor.requestCheck('first price loaded'))
      payoutWorker.start()
      if (env.ENGINE_ENABLED) engine.start()
      reconciler.start()
      memory?.startMarket()
      if (sweeper) {
        const run = () => {
          if (sweeping) return
          sweeping = (async () => {
            // single sweeper across all instances (claims are measured per run; two runs would double-count)
            const release = await tryAdvisoryLock(database.pool, LOCK_KEYS.sweeper)
            if (!release) return
            try {
              await sweeper.runOnce()
            } catch (e) {
              alerter.notify({
                kind: 'sweep.error',
                severity: 'warn',
                message: `sweeper run failed: ${(e as Error).message}`,
                dedupeKey: 'sweep.error',
              })
            } finally {
              await release()
            }
          })().finally(() => {
            sweeping = null
          })
        }
        sweepTimer = setInterval(run, economy.sweepIntervalMin * 60_000)
        sweepTimer.unref()
      }
    },
    async stop() {
      if (sweepTimer) clearInterval(sweepTimer)
      if (mintTimer) clearInterval(mintTimer)
      pauses.stopSync()
      await sweeping // never abandon a claim/swap mid-flight
      await engine.stop()
      reconciler.stop()
      oracle.stop()
      monitor.stop()
      await payoutWorker.stop()
      memory?.chain.stop()
      await alerter.close()
      if (!opts.database) await database.close()
    },
  }
}

// ── memory world ─────────────────────────────────────────────────────────────
function buildMemoryWorld(o: {
  prizeAddress: string
  creatorAddress: string
  pumpMint: string
  scratchyMint: string
  mockPumpUsd: string
}): MemoryWorld {
  const chain = new MemoryChainClient({
    prizeAddress: o.prizeAddress,
    creatorAddress: o.creatorAddress,
    mints: [
      {
        address: o.pumpMint,
        decimals: 6,
        token2022: true,
        extensions: ['TransferHook', 'MetadataPointer', 'TokenMetadata'],
      },
      { address: o.scratchyMint, decimals: 6 },
    ],
    autoAdvanceMs: 400,
  })
  const pumpUsd = Number(o.mockPumpUsd) || 0.0056
  const PUMP = (usd: number) => BigInt(Math.round((usd / pumpUsd) * 1e6))
  // a ~$1,500 prize pool (+1% jackpot seed happens at the genesis round), gas for both signers
  chain.setSol(o.prizeAddress, 2_000_000_000n)
  chain.setSol(o.creatorAddress, 1_000_000_000n)
  chain.credit(o.prizeAddress, o.pumpMint, PUMP(1_500))
  // pool priced at $0.0005 per SCRATCHY: 100M SCRATCHY vs PUMP worth $50k
  const venue = new MemoryVenue({
    chain,
    creator: o.creatorAddress,
    baseMint: o.scratchyMint,
    quoteMint: o.pumpMint,
    baseDecimals: 6,
    quoteDecimals: 6,
    baseReserveRaw: 100_000_000_000_000n,
    quoteReserveRaw: PUMP(50_000),
    collectFeeMode: 'OnlyB',
  })
  chain.advance(8) // genesis balances are finalized history, not the current block
  const seen = new Set<string>()
  let marketTimer: NodeJS.Timeout | null = null
  return {
    chain,
    venue,
    async faucet(wallet: string) {
      if (seen.has(wallet)) return
      seen.add(wallet)
      if ((await chain.getTokenBalance(wallet, o.scratchyMint)).value > 0n) return
      // deterministic holdings between ~$60 and ~$6,000 so every tier of the UI can be tried locally
      const h = sha256(utf8ToBytes(wallet))
      const usd = 60 * Math.pow(100, h[0]! / 255)
      const scratchyTokens = usd / 0.0005
      chain.credit(wallet, o.scratchyMint, BigInt(Math.round(scratchyTokens * 1e6)))
    },
    startMarket() {
      if (marketTimer) return
      // ≈ $40k/day of volume (the §2.6 example) as a trade every ~2 s
      marketTimer = setInterval(() => {
        const usd = 40_000 / 43_200
        const side = Math.random() < 0.5 ? 'buy' : 'sell'
        if (side === 'buy') venue.trade('buy', PUMP(usd))
        else venue.trade('sell', BigInt(Math.round((usd / 0.0005) * 1e6)))
      }, 2_000)
      marketTimer.unref()
    },
  }
}

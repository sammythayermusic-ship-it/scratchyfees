import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  AccountType,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getExtraAccountMetaAddress,
  MINT_SIZE,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type AccountInfo,
  type Connection,
  type ParsedTransactionWithMeta,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { createPublicKey, verify } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isValidPublicKey, isValidWalletAddress, normalizeWalletAddress } from '../src/chain/address'
import { clusterFromGenesis, GENESIS_HASHES, verifyCluster } from '../src/chain/cluster'
import { keypairFromEnv, loadKeypair, loadKeypairFile } from '../src/chain/keys'
import { decodeMintAccount, inspectMint } from '../src/chain/mint'
import {
  decodeTokenAccount,
  decodeTokenAccountAmount,
  MEMO_PROGRAM_ID,
  parsePayoutTx,
  percentile75NonZero,
  renderTxError,
  SolanaChainClient,
} from '../src/chain/solana'
import { payoutMemo, TransientChainError } from '../src/chain/types'
import { classifyFailure } from '../src/payouts/classify'

// ── fixtures ─────────────────────────────────────────────────────────────────

const seeded = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n))
const PRIZE = seeded(1)
const CREATOR = seeded(2)
const ALICE = seeded(3).publicKey
const BOB = seeded(4).publicKey
const MINT = seeded(10).publicKey // stands in for mock-PUMP (Token-2022)
const LEGACY_MINT = seeded(11).publicKey // classic SPL Token mint
const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(7))

function tlv(type: number, data: Uint8Array = new Uint8Array(0)): Buffer {
  const h = Buffer.alloc(4)
  h.writeUInt16LE(type, 0)
  h.writeUInt16LE(data.length, 2)
  return Buffer.concat([h, Buffer.from(data)])
}

function mintData(decimals: number, supply: bigint, extensions?: Buffer[]): Buffer {
  const base = Buffer.alloc(MINT_SIZE)
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    base,
  )
  if (!extensions) return base
  return Buffer.concat([
    base,
    Buffer.alloc(ACCOUNT_SIZE - MINT_SIZE),
    Buffer.from([AccountType.Mint]),
    ...extensions,
  ])
}

/** transferHook extension: authority set, program id as given (default = unset, like real PUMP) */
function hookExt(program: PublicKey = PublicKey.default): Buffer {
  return tlv(ExtensionType.TransferHook, Buffer.concat([seeded(20).publicKey.toBuffer(), program.toBuffer()]))
}
const metadataPointerExt = () =>
  tlv(ExtensionType.MetadataPointer, Buffer.concat([seeded(20).publicKey.toBuffer(), MINT.toBuffer()]))

/** a PUMP-shaped Token-2022 mint: 6 dp, transferHook (unset) + metadataPointer */
function pumpLikeMint(hookProgram?: PublicKey): Buffer {
  return mintData(6, 1_000_000_000_000_000n, [hookExt(hookProgram), metadataPointerExt()])
}

function account(owner: PublicKey, data: Buffer): AccountInfo<Buffer> {
  return { owner, data, lamports: 2_039_280, executable: false, rentEpoch: 0 }
}

/** 165-byte base token account; `token2022Extensions` appends accountType + ImmutableOwner + TransferHookAccount → 175 bytes */
function tokenAccountData(
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
  token2022Extensions = false,
  state: AccountState = AccountState.Initialized,
): Buffer {
  const base = Buffer.alloc(ACCOUNT_SIZE)
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    base,
  )
  if (!token2022Extensions) return base
  return Buffer.concat([
    base,
    Buffer.from([AccountType.Account]),
    tlv(ExtensionType.ImmutableOwner),
    tlv(ExtensionType.TransferHookAccount, Uint8Array.of(0)),
  ])
}

type Call = { method: string; args: unknown[] }

/** A fake Connection: only the methods the client uses, backed by an in-memory account map. */
class StubConnection {
  rpcEndpoint = 'https://api.devnet.solana.com'
  calls: Call[] = []
  accounts = new Map<string, AccountInfo<Buffer>>()
  slot = 5_000
  genesis: string = GENESIS_HASHES.devnet
  statusContextSlots: number[] = []
  statusValues: (object | null)[] | null = null
  simulateValue: object = { err: null, logs: ['Program log: ok'], unitsConsumed: 42_000 }
  prioritizationFees: number[] = []
  sendError: Error | null = null
  /** getAccountInfo for these addresses fails like a flaky RPC */
  failAccountInfo = new Set<string>()
  /** context slots handed, in call order, to getMultipleAccountsInfoAndContext (then `slot`) */
  multiSlots: number[] = []
  /** errors thrown, in call order, by getMultipleAccountsInfoAndContext (null = answer normally) */
  multiErrors: (Error | null)[] = []
  /** runs after every getTokenAccountsByOwner answer (lets a test move tokens between discovery and read) */
  afterTokenAccountsByOwner: (() => void) | null = null
  /** signature → getTransaction response */
  txs = new Map<string, object>()

  private log(method: string, ...args: unknown[]) {
    this.calls.push({ method, args })
  }
  callsTo(method: string) {
    return this.calls.filter((c) => c.method === method)
  }

  async getGenesisHash() {
    this.log('getGenesisHash')
    return this.genesis
  }
  async getAccountInfo(pk: PublicKey, commitment?: unknown) {
    this.log('getAccountInfo', pk.toBase58(), commitment)
    if (this.failAccountInfo.has(pk.toBase58())) throw new Error('503 Service Unavailable')
    return this.accounts.get(pk.toBase58()) ?? null
  }
  async getAccountInfoAndContext(pk: PublicKey, commitment?: unknown) {
    this.log('getAccountInfoAndContext', pk.toBase58(), commitment)
    return { context: { slot: this.slot }, value: this.accounts.get(pk.toBase58()) ?? null }
  }
  async getLatestBlockhash(commitment?: unknown) {
    this.log('getLatestBlockhash', commitment)
    return { blockhash: BLOCKHASH, lastValidBlockHeight: 9_150 }
  }
  async getMultipleAccountsInfoAndContext(pks: PublicKey[], config?: unknown) {
    this.log(
      'getMultipleAccountsInfoAndContext',
      pks.map((p) => p.toBase58()),
      config,
    )
    const err = this.multiErrors.shift()
    if (err) throw err
    return {
      context: { slot: this.multiSlots.shift() ?? this.slot },
      value: pks.map((p) => this.accounts.get(p.toBase58()) ?? null),
    }
  }
  /** like the RPC's token index: every token-program account whose mint and owner fields match */
  async getTokenAccountsByOwner(owner: PublicKey, filter: { mint: PublicKey }, commitment?: unknown) {
    this.log('getTokenAccountsByOwner', owner.toBase58(), filter.mint.toBase58(), commitment)
    const value: { pubkey: PublicKey; account: AccountInfo<Buffer> }[] = []
    for (const [address, acc] of this.accounts) {
      const tokenProgram = acc.owner.equals(TOKEN_PROGRAM_ID) || acc.owner.equals(TOKEN_2022_PROGRAM_ID)
      if (!tokenProgram || acc.data.length < ACCOUNT_SIZE) continue
      if (!acc.data.subarray(0, 32).equals(filter.mint.toBuffer())) continue
      if (!acc.data.subarray(32, 64).equals(owner.toBuffer())) continue
      value.push({ pubkey: new PublicKey(address), account: acc })
    }
    this.afterTokenAccountsByOwner?.()
    return { context: { slot: this.slot - 3 }, value }
  }
  async getTransaction(signature: string, config?: unknown) {
    this.log('getTransaction', signature, config)
    return this.txs.get(signature) ?? null
  }
  async getSignatureStatuses(sigs: string[], config?: unknown) {
    this.log('getSignatureStatuses', sigs, config)
    const n = this.callsTo('getSignatureStatuses').length - 1
    return {
      context: { slot: this.statusContextSlots[n] ?? this.slot },
      value: this.statusValues ? this.statusValues.slice(0, sigs.length) : sigs.map(() => null),
    }
  }
  async simulateTransaction(tx: VersionedTransaction, config?: unknown) {
    this.log('simulateTransaction', tx, config)
    return { context: { slot: this.slot }, value: this.simulateValue }
  }
  async sendRawTransaction(bytes: Uint8Array, opts?: unknown) {
    this.log('sendRawTransaction', bytes, opts)
    if (this.sendError) throw this.sendError
    return bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!)
  }
  async getEpochInfo(commitment?: unknown) {
    this.log('getEpochInfo', commitment)
    return { epoch: 800, slotIndex: 1, slotsInEpoch: 432_000, absoluteSlot: 345_678, blockHeight: 300_123 }
  }
  async getRecentPrioritizationFees(config?: unknown) {
    this.log('getRecentPrioritizationFees', config)
    return this.prioritizationFees.map((f, i) => ({ slot: i, prioritizationFee: f }))
  }
  async getSlot(commitment?: unknown) {
    this.log('getSlot', commitment)
    return this.slot
  }
}

function setup(
  opts: { creator?: boolean; fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {},
) {
  const conn = new StubConnection()
  conn.accounts.set(MINT.toBase58(), account(TOKEN_2022_PROGRAM_ID, pumpLikeMint()))
  conn.accounts.set(LEGACY_MINT.toBase58(), account(TOKEN_PROGRAM_ID, mintData(9, 5_000n)))
  const clock = { now: 1_700_000_000_000 }
  const client = new SolanaChainClient({
    connection: conn as unknown as Connection,
    cluster: 'devnet',
    prize: PRIZE,
    creator: opts.creator === false ? null : CREATOR,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    now: () => clock.now,
    holdingsRetryDelayMs: 0,
  })
  return { conn, client, clock }
}

const ata = (owner: PublicKey, mint = MINT, program = TOKEN_2022_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(mint, owner, true, program)

/** put a token account of `mint` (owner field `owner`) at `address` */
function putToken(
  conn: StubConnection,
  address: PublicKey,
  owner: PublicKey,
  amount: bigint,
  opts: { mint?: PublicKey; ext?: boolean; state?: AccountState } = {},
) {
  const mint = opts.mint ?? MINT
  const program = mint.equals(LEGACY_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID
  conn.accounts.set(
    address.toBase58(),
    account(program, tokenAccountData(mint, owner, amount, opts.ext ?? false, opts.state)),
  )
}

// transfer-hook extra-account-metas account (spl-transfer-hook-interface ExtraAccountMetaList for Execute)
const HOOK = seeded(30).publicKey
const EXECUTE_DISCRIMINATOR = Buffer.from([105, 37, 101, 197, 75, 251, 102, 26])
type HookMeta = { discriminator: number; config: number[]; isSigner?: boolean; isWritable?: boolean }

function extraMetasData(metas: HookMeta[]): Buffer {
  const list = Buffer.alloc(4 + 35 * metas.length)
  list.writeUInt32LE(metas.length, 0)
  metas.forEach((m, i) => {
    const o = 4 + 35 * i
    list[o] = m.discriminator
    Buffer.from(m.config).copy(list, o + 1)
    list[o + 33] = m.isSigner ? 1 : 0
    list[o + 34] = m.isWritable ? 1 : 0
  })
  const len = Buffer.alloc(4)
  len.writeUInt32LE(list.length, 0)
  return Buffer.concat([EXECUTE_DISCRIMINATOR, len, list])
}

/** a mint with hook program HOOK and (unless `validation` is null) its validation account */
function withHook(
  conn: StubConnection,
  metas: HookMeta[],
  validation: { owner: PublicKey } | null = { owner: HOOK },
) {
  conn.accounts.set(MINT.toBase58(), account(TOKEN_2022_PROGRAM_ID, pumpLikeMint(HOOK)))
  const address = getExtraAccountMetaAddress(MINT, HOOK)
  if (validation) conn.accounts.set(address.toBase58(), account(validation.owner, extraMetasData(metas)))
  return address
}

function decodeTx(bytes: Uint8Array) {
  const tx = VersionedTransaction.deserialize(bytes)
  const keys = tx.message.staticAccountKeys
  const ixs = tx.message.compiledInstructions.map((ix) => ({
    program: keys[ix.programIdIndex]!.toBase58(),
    data: Buffer.from(ix.data),
    accounts: ix.accountKeyIndexes.map((i) => keys[i]!.toBase58()),
  }))
  return { tx, keys, ixs }
}

const baseReq = {
  signer: 'prize' as const,
  recipient: ALICE.toBase58(),
  mint: MINT.toBase58(),
  amountRaw: 12_500_000_000n,
  memo: payoutMemo('devnet-test', 42n),
  priorityFeeMicroLamports: 25_000,
}

// ── keys ─────────────────────────────────────────────────────────────────────

describe('keys', () => {
  const kp = seeded(42)
  const b58 = bs58.encode(kp.secretKey)
  const json = JSON.stringify(Array.from(kp.secretKey))

  it('parses base58 and JSON byte-array secrets to the same keypair', () => {
    expect(loadKeypair(b58).publicKey.equals(kp.publicKey)).toBe(true)
    expect(loadKeypair(json).publicKey.equals(kp.publicKey)).toBe(true)
    expect(loadKeypair(`  ${json}\n`).publicKey.equals(kp.publicKey)).toBe(true)
  })

  it('rejects malformed secrets without echoing them', () => {
    const bad = [
      '',
      '[1,2,3',
      '[1,2,300]',
      JSON.stringify(Array.from(kp.secretKey.slice(0, 32))),
      'not-base58-0OIl',
      bs58.encode(kp.secretKey.slice(0, 63)),
    ]
    for (const s of bad) {
      let msg = ''
      try {
        loadKeypair(s)
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg).not.toBe('')
      if (s.length > 8) expect(msg).not.toContain(s.slice(0, 8))
    }
    // a 64-byte key whose public half does not match its private half
    const tampered = Uint8Array.from(kp.secretKey)
    tampered[40] = tampered[40]! ^ 1
    expect(() => loadKeypair(bs58.encode(tampered))).toThrow(/invalid/)
  })

  it('keypairFromEnv requires the configured address', () => {
    expect(keypairFromEnv(b58, kp.publicKey.toBase58()).publicKey.equals(kp.publicKey)).toBe(true)
    let msg = ''
    try {
      keypairFromEnv(b58, ALICE.toBase58(), 'PRIZE')
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/PRIZE key mismatch/)
    expect(msg).toContain(kp.publicKey.toBase58())
    expect(msg).not.toContain(b58)
    expect(msg).not.toContain(b58.slice(0, 16))
  })

  it('key files are devnet/localnet only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scratchy-keys-'))
    const path = join(dir, 'prize.json')
    writeFileSync(path, json)
    expect(loadKeypairFile(path, 'devnet').publicKey.equals(kp.publicKey)).toBe(true)
    expect(loadKeypairFile(path, 'localnet').publicKey.equals(kp.publicKey)).toBe(true)
    expect(() => loadKeypairFile(path, 'mainnet-beta')).toThrow(/devnet\/localnet-only/)
    expect(() => loadKeypairFile(path, 'memory')).toThrow(/devnet\/localnet-only/)
    expect(() => loadKeypairFile(join(dir, 'missing.json'), 'devnet')).toThrow(/ENOENT/)
  })
})

// ── addresses ────────────────────────────────────────────────────────────────

describe('wallet address validation', () => {
  it('accepts on-curve wallets', () => {
    expect(isValidWalletAddress('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).toBe(true)
    expect(isValidWalletAddress(PRIZE.publicKey.toBase58())).toBe(true)
    expect(normalizeWalletAddress(`  ${ALICE.toBase58()} \n`)).toBe(ALICE.toBase58())
  })

  it('rejects PDAs (vaults) but still recognises them as public keys', () => {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), MINT.toBuffer()],
      TOKEN_2022_PROGRAM_ID,
    )
    expect(isValidPublicKey(pda.toBase58())).toBe(true)
    expect(isValidWalletAddress(pda.toBase58())).toBe(false)
    expect(isValidWalletAddress(ata(ALICE).toBase58())).toBe(false)
    expect(normalizeWalletAddress(pda.toBase58())).toBeNull()
  })

  it('rejects garbage', () => {
    for (const s of [
      '',
      'hello',
      '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl',
      `${ALICE.toBase58()}x`,
      bs58.encode(new Uint8Array(33).fill(9)),
      bs58.encode(new Uint8Array(31).fill(9)),
      ` ${ALICE.toBase58()}`,
      null,
      42,
    ]) {
      expect(isValidWalletAddress(s)).toBe(false)
    }
    expect(normalizeWalletAddress(undefined)).toBeNull()
  })
})

// ── cluster ──────────────────────────────────────────────────────────────────

describe('cluster genesis', () => {
  it('maps genesis hashes', () => {
    expect(clusterFromGenesis('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')).toBe('mainnet-beta')
    expect(clusterFromGenesis('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')).toBe('devnet')
    expect(clusterFromGenesis('4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY')).toBe('testnet')
    expect(clusterFromGenesis(BLOCKHASH)).toBe('localnet')
  })

  it('verifyCluster accepts a match and refuses a mismatch', async () => {
    const conn = (hash: string) => ({ getGenesisHash: async () => hash })
    await expect(verifyCluster(conn(GENESIS_HASHES.devnet), 'devnet')).resolves.toBe(GENESIS_HASHES.devnet)
    await expect(verifyCluster(conn(GENESIS_HASHES['mainnet-beta']), 'devnet')).rejects.toThrow(
      /cluster mismatch/,
    )
    await expect(verifyCluster(conn(GENESIS_HASHES.devnet), 'mainnet-beta')).rejects.toThrow(
      /cluster mismatch/,
    )
    await expect(verifyCluster(conn(BLOCKHASH), 'localnet')).resolves.toBe(BLOCKHASH)
    await expect(verifyCluster(conn(GENESIS_HASHES.devnet), 'localnet')).rejects.toThrow(/serves devnet/)
    await expect(verifyCluster(conn(GENESIS_HASHES.testnet), 'localnet')).rejects.toThrow(/serves testnet/)
    const down = {
      getGenesisHash: async (): Promise<string> => {
        throw new Error('fetch failed')
      },
    }
    await expect(verifyCluster(down, 'devnet')).rejects.toBeInstanceOf(TransientChainError)
  })

  it('the client verifies through the same check', async () => {
    const { conn, client } = setup()
    await expect(client.verifyCluster()).resolves.toBeUndefined()
    conn.genesis = GENESIS_HASHES['mainnet-beta']
    await expect(client.verifyCluster()).rejects.toThrow(/cluster mismatch/)
  })
})

// ── mint inspection ──────────────────────────────────────────────────────────

describe('mint inspection', () => {
  const addr = MINT.toBase58()

  it('decodes a PUMP-shaped Token-2022 mint (hook extension present, program unset)', () => {
    const info = decodeMintAccount(addr, account(TOKEN_2022_PROGRAM_ID, pumpLikeMint()))
    expect(info).toEqual({
      address: addr,
      decimals: 6,
      tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
      isToken2022: true,
      supply: 1_000_000_000_000_000n,
      extensions: ['TransferHook', 'MetadataPointer'],
      transferHookProgram: null,
      blockingExtensions: [],
    })
  })

  it('reports a configured hook program', () => {
    const hook = seeded(30).publicKey
    const info = decodeMintAccount(addr, account(TOKEN_2022_PROGRAM_ID, pumpLikeMint(hook)))
    expect(info.transferHookProgram).toBe(hook.toBase58())
    expect(info.blockingExtensions).toEqual([])
  })

  it('flags extensions that change transfer semantics', () => {
    const blocked = decodeMintAccount(
      addr,
      account(
        TOKEN_2022_PROGRAM_ID,
        mintData(6, 1n, [
          tlv(ExtensionType.TransferFeeConfig, new Uint8Array(108)),
          tlv(ExtensionType.PermanentDelegate, seeded(5).publicKey.toBuffer()),
          tlv(ExtensionType.NonTransferable),
          tlv(ExtensionType.DefaultAccountState, Uint8Array.of(AccountState.Frozen)),
        ]),
      ),
    )
    expect(blocked.blockingExtensions).toEqual([
      'TransferFeeConfig',
      'PermanentDelegate',
      'NonTransferable',
      'DefaultAccountState',
    ])
    const thawed = decodeMintAccount(
      addr,
      account(
        TOKEN_2022_PROGRAM_ID,
        mintData(6, 1n, [tlv(ExtensionType.DefaultAccountState, Uint8Array.of(AccountState.Initialized))]),
      ),
    )
    expect(thawed.extensions).toEqual(['DefaultAccountState'])
    expect(thawed.blockingExtensions).toEqual([])
    const unknown = decodeMintAccount(
      addr,
      account(TOKEN_2022_PROGRAM_ID, mintData(6, 1n, [tlv(99, Uint8Array.of(1))])),
    )
    expect(unknown.blockingExtensions).toEqual(['Unknown(99)'])
  })

  it('decodes a legacy SPL mint and rejects non-mints', async () => {
    const legacy = decodeMintAccount(LEGACY_MINT.toBase58(), account(TOKEN_PROGRAM_ID, mintData(9, 5_000n)))
    expect(legacy).toMatchObject({ decimals: 9, isToken2022: false, supply: 5_000n, extensions: [] })
    expect(() => decodeMintAccount(addr, account(SystemProgram.programId, mintData(6, 1n)))).toThrow(
      /not an SPL/,
    )
    expect(() => decodeMintAccount(addr, null)).toThrow(/not found/)
    const down = {
      getAccountInfo: async (): Promise<AccountInfo<Buffer> | null> => {
        throw new Error('503 Service Unavailable')
      },
    }
    await expect(inspectMint(down, addr)).rejects.toBeInstanceOf(TransientChainError)
  })
})

// ── buildTransferTx ──────────────────────────────────────────────────────────

describe('buildTransferTx', () => {
  it('orders instructions: compute budget → idempotent ATA create → memo → transferChecked', async () => {
    const { conn, client } = setup()
    const built = await client.buildTransferTx(baseReq)
    const { tx, keys, ixs } = decodeTx(built.bytes)

    expect(keys[0]!.equals(PRIZE.publicKey)).toBe(true) // fee payer = signer
    expect(tx.message.recentBlockhash).toBe(BLOCKHASH)
    expect(built.blockhash).toBe(BLOCKHASH)
    expect(built.lastValidBlockHeight).toBe(9_150)
    expect(ixs.map((i) => i.program)).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      MEMO_PROGRAM_ID.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
    ])
    const [limit, price, create, memo, transfer] = ixs as [
      (typeof ixs)[0],
      (typeof ixs)[0],
      (typeof ixs)[0],
      (typeof ixs)[0],
      (typeof ixs)[0],
    ]
    // compute budget
    expect(limit.data[0]).toBe(2)
    expect(limit.data.readUInt32LE(1)).toBe(120_000)
    expect(price.data[0]).toBe(3)
    expect(price.data.readBigUInt64LE(1)).toBe(25_000n)
    // idempotent create of the recipient's Token-2022 ATA, paid by the signer
    expect([...create.data]).toEqual([1])
    expect(create.accounts.slice(0, 4)).toEqual([
      PRIZE.publicKey.toBase58(),
      ata(ALICE).toBase58(),
      ALICE.toBase58(),
      MINT.toBase58(),
    ])
    expect(create.accounts).toContain(TOKEN_2022_PROGRAM_ID.toBase58())
    // memo signed by the sender, immediately before the transfer
    expect(memo.data.toString('utf8')).toBe('scratchy:devnet-test:42')
    expect(memo.accounts).toEqual([PRIZE.publicKey.toBase58()])
    expect(tx.message.isAccountSigner(keys.findIndex((k) => k.equals(PRIZE.publicKey)))).toBe(true)
    // transferChecked(amount, decimals) from the signer's ATA
    expect(transfer.data[0]).toBe(12)
    expect(transfer.data.readBigUInt64LE(1)).toBe(12_500_000_000n)
    expect(transfer.data[9]).toBe(6)
    // hook extension present but its program unset → a plain transferChecked, exactly 4 accounts
    expect(transfer.accounts).toEqual([
      ata(PRIZE.publicKey).toBase58(),
      MINT.toBase58(),
      ata(ALICE).toBase58(),
      PRIZE.publicKey.toBase58(),
    ])
    // …and the extra-account-metas PDA of the default program id is never even looked at
    const validation = getExtraAccountMetaAddress(MINT, PublicKey.default).toBase58()
    expect(conn.callsTo('getAccountInfo').some((c) => c.args[0] === validation)).toBe(false)
    expect(built.createsAta).toBe(true)
  })

  it('an unset hook cannot be griefed by funding the default-program validation PDA', async () => {
    const { conn, client } = setup()
    const griefPda = getExtraAccountMetaAddress(MINT, PublicKey.default)
    // anyone can create an account at this address (e.g. owned by the System Program, garbage data)
    conn.accounts.set(griefPda.toBase58(), account(SystemProgram.programId, Buffer.alloc(3, 0xff)))
    const built = await client.buildTransferTx(baseReq)
    const transfer = decodeTx(built.bytes).ixs[4]!
    expect(transfer.accounts.length).toBe(4)
    expect(transfer.accounts).not.toContain(griefPda.toBase58())
    // reads: our cached mint inspect, the destination ATA check, one fresh mint read — nothing else
    expect(conn.callsTo('getAccountInfo').map((c) => c.args[0])).toEqual([
      MINT.toBase58(),
      ata(ALICE).toBase58(),
      MINT.toBase58(),
    ])
  })

  it('appends the extra accounts resolved from a hook program’s own validation account', async () => {
    const { conn, client } = setup()
    const fixed = seeded(40).publicKey
    const validation = withHook(conn, [
      // a fixed writable account
      { discriminator: 0, config: [...fixed.toBytes()], isWritable: true },
      // a hook-program PDA from a literal and the destination key (account index 2)
      { discriminator: 1, config: [1, 7, ...Buffer.from('counter'), 3, 2], isWritable: true },
      // a hook-program PDA from account data: the source account's owner field (bytes 32..64)
      { discriminator: 1, config: [4, 0, 32, 32] },
    ])
    putToken(conn, ata(PRIZE.publicKey), PRIZE.publicKey, 1_000_000n, { ext: true })

    const built = await client.buildTransferTx(baseReq)
    const { tx, keys, ixs } = decodeTx(built.bytes)
    const transfer = ixs[4]!
    expect(transfer.program).toBe(TOKEN_2022_PROGRAM_ID.toBase58())
    const counter = PublicKey.findProgramAddressSync([Buffer.from('counter'), ata(ALICE).toBuffer()], HOOK)[0]
    const bySource = PublicKey.findProgramAddressSync([PRIZE.publicKey.toBuffer()], HOOK)[0]
    expect(transfer.accounts).toEqual([
      ata(PRIZE.publicKey).toBase58(),
      MINT.toBase58(),
      ata(ALICE).toBase58(),
      PRIZE.publicKey.toBase58(),
      fixed.toBase58(),
      counter.toBase58(),
      bySource.toBase58(),
      HOOK.toBase58(),
      validation.toBase58(),
    ])
    const writable = (pk: PublicKey) => tx.message.isAccountWritable(keys.findIndex((k) => k.equals(pk)))
    expect(writable(fixed)).toBe(true)
    expect(writable(bySource)).toBe(false)
    expect(writable(validation)).toBe(false)
    // the validation account is read once — the extras come from exactly the account whose owner was checked
    expect(conn.callsTo('getAccountInfo').filter((c) => c.args[0] === validation.toBase58()).length).toBe(1)
    // the order around the transfer is unchanged: memo immediately before it
    expect(ixs[3]!.program).toBe(MEMO_PROGRAM_ID.toBase58())
  })

  it('refuses (non-transient) a hook whose validation account is missing or not owned by the hook', async () => {
    for (const validation of [null, { owner: SystemProgram.programId }, { owner: seeded(41).publicKey }]) {
      const { conn, client } = setup()
      withHook(conn, [{ discriminator: 0, config: [...seeded(40).publicKey.toBytes()] }], validation)
      const err = await client.buildTransferTx(baseReq).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(TransientChainError)
      expect((err as Error).message).toMatch(/transfer hook .* cannot be resolved/)
      expect((err as Error).message).toMatch(validation ? /not the hook program/ : /does not exist/)
    }
  })

  it('refuses a hook whose extras demand a signature or cannot be decoded', async () => {
    const { conn, client } = setup()
    withHook(conn, [{ discriminator: 0, config: [...seeded(40).publicKey.toBytes()], isSigner: true }])
    const signer = await client.buildTransferTx(baseReq).catch((e: unknown) => e)
    expect(signer).not.toBeInstanceOf(TransientChainError)
    expect((signer as Error).message).toMatch(/cannot be resolved: an extra account demands a signature/)

    const validation = getExtraAccountMetaAddress(MINT, HOOK)
    conn.accounts.set(validation.toBase58(), account(HOOK, Buffer.from([1, 2, 3])))
    const garbage = await client.buildTransferTx(baseReq).catch((e: unknown) => e)
    expect(garbage).toBeInstanceOf(Error)
    expect(garbage).not.toBeInstanceOf(TransientChainError)
    expect((garbage as Error).message).toMatch(/cannot be resolved/)
  })

  it('RPC failures while resolving a set hook stay transient', async () => {
    const { conn, client } = setup()
    const validation = withHook(conn, [{ discriminator: 1, config: [4, 0, 32, 32] }])
    conn.failAccountInfo.add(ata(PRIZE.publicKey).toBase58()) // the account-data seed read
    await expect(client.buildTransferTx(baseReq)).rejects.toBeInstanceOf(TransientChainError)
    conn.failAccountInfo.clear()
    conn.failAccountInfo.add(validation.toBase58())
    await expect(client.buildTransferTx(baseReq)).rejects.toBeInstanceOf(TransientChainError)
  })

  it('re-reads the mint for every build, so a hook program set at runtime is seen', async () => {
    const { conn, client } = setup()
    await client.getMintInfo(MINT.toBase58()) // metadata cached with the hook unset
    expect(decodeTx((await client.buildTransferTx(baseReq)).bytes).ixs[4]!.accounts.length).toBe(4)
    withHook(conn, [], null) // hook program set, no validation account yet
    await expect(client.buildTransferTx(baseReq)).rejects.toThrow(/cannot be resolved/)
  })

  it('honours the request compute-unit limit, clamped to [20k, 1.4M]', async () => {
    const { client } = setup()
    const limitOf = async (computeUnitLimit?: number) =>
      decodeTx(
        (await client.buildTransferTx({ ...baseReq, computeUnitLimit })).bytes,
      ).ixs[0]!.data.readUInt32LE(1)
    expect(await limitOf(undefined)).toBe(120_000)
    expect(await limitOf(250_000)).toBe(250_000)
    expect(await limitOf(180_000.9)).toBe(180_000)
    expect(await limitOf(5_000)).toBe(20_000)
    expect(await limitOf(9_000_000)).toBe(1_400_000)
    await expect(client.buildTransferTx({ ...baseReq, computeUnitLimit: Number.NaN })).rejects.toThrow(
      /compute unit limit/,
    )
    const a = await client.buildTransferTx({ ...baseReq, computeUnitLimit: 200_000 })
    const b = await client.buildTransferTx({ ...baseReq, computeUnitLimit: 200_001 })
    expect(a.signature).not.toBe(b.signature)
  })

  it('signature is the signed tx signature and verifies against the signer key', async () => {
    const { client } = setup()
    const built = await client.buildTransferTx(baseReq)
    const { tx } = decodeTx(built.bytes)
    expect(Buffer.from(tx.signatures[0]!).equals(Buffer.from(bs58.decode(built.signature)))).toBe(true)
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), PRIZE.publicKey.toBuffer()])
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    expect(verify(null, tx.message.serialize(), key, tx.signatures[0]!)).toBe(true)
  })

  it('identical inputs + blockhash produce identical bytes; any change produces a new signature', async () => {
    const { client } = setup()
    const a = await client.buildTransferTx(baseReq)
    const b = await client.buildTransferTx(baseReq)
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true)
    expect(a.signature).toBe(b.signature)
    const c = await client.buildTransferTx({ ...baseReq, memo: payoutMemo('devnet-test', 43n) })
    expect(c.signature).not.toBe(a.signature)
  })

  it('keeps the idempotent create even when the ATA exists, reporting createsAta=false', async () => {
    const { conn, client } = setup()
    conn.accounts.set(
      ata(ALICE).toBase58(),
      account(TOKEN_2022_PROGRAM_ID, tokenAccountData(MINT, ALICE, 0n, true)),
    )
    const built = await client.buildTransferTx(baseReq)
    expect(built.createsAta).toBe(false)
    expect(decodeTx(built.bytes).ixs[2]!.program).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58())
    expect(await client.ataExists(ALICE.toBase58(), MINT.toBase58())).toBe(true)
    expect(await client.ataExists(BOB.toBase58(), MINT.toBase58())).toBe(false)
  })

  it('uses the mint program for legacy SPL mints and caches mint metadata', async () => {
    const { conn, client } = setup()
    const req = { ...baseReq, mint: LEGACY_MINT.toBase58(), amountRaw: 5n }
    const built = await client.buildTransferTx(req)
    const { ixs } = decodeTx(built.bytes)
    expect(ixs[4]!.program).toBe(TOKEN_PROGRAM_ID.toBase58())
    expect(ixs[4]!.data[9]).toBe(9)
    expect(ixs[2]!.accounts[1]).toBe(ata(ALICE, LEGACY_MINT, TOKEN_PROGRAM_ID).toBase58())
    await client.buildTransferTx(req)
    // our own mint lookup happens once; later reads are only the spl-token helper's hook check
    const mintReads = conn.callsTo('getAccountInfo').filter((c) => c.args[0] === LEGACY_MINT.toBase58())
    expect(mintReads.length).toBe(3) // 1 cached inspect + 1 getMint per build
  })

  it('signs with CREATOR for the creator role, and refuses when none is configured', async () => {
    const { client } = setup()
    const built = await client.buildTransferTx({
      ...baseReq,
      signer: 'creator',
      recipient: PRIZE.publicKey.toBase58(),
    })
    expect(decodeTx(built.bytes).keys[0]!.equals(CREATOR.publicKey)).toBe(true)
    const { client: noCreator } = setup({ creator: false })
    expect(noCreator.creatorAddress).toBeNull()
    await expect(noCreator.buildTransferTx({ ...baseReq, signer: 'creator' })).rejects.toThrow(/no CREATOR/)
  })

  it('rejects zero / oversized amounts and self-transfers', async () => {
    const { client } = setup()
    await expect(client.buildTransferTx({ ...baseReq, amountRaw: 0n })).rejects.toThrow(/amount/)
    await expect(client.buildTransferTx({ ...baseReq, amountRaw: 1n << 64n })).rejects.toThrow(/amount/)
    await expect(
      client.buildTransferTx({ ...baseReq, recipient: PRIZE.publicKey.toBase58() }),
    ).rejects.toThrow(/signer itself/)
  })

  it('maps RPC trouble while building to TransientChainError', async () => {
    const { conn, client } = setup()
    conn.getLatestBlockhash = async () => {
      throw new Error('429 Too Many Requests: rate limited')
    }
    await expect(client.buildTransferTx(baseReq)).rejects.toBeInstanceOf(TransientChainError)
  })
})

// ── simulate / send ──────────────────────────────────────────────────────────

describe('simulate and sendRaw', () => {
  it('simulates the exact bytes without sig verify or blockhash replacement', async () => {
    const { conn, client } = setup()
    const built = await client.buildTransferTx(baseReq)
    const ok = await client.simulate(built.bytes)
    expect(ok).toEqual({
      ok: true,
      error: null,
      permanent: false,
      logs: ['Program log: ok'],
      unitsConsumed: 42_000,
    })
    const call = conn.callsTo('simulateTransaction')[0]!
    expect(call.args[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false })
    expect((call.args[0] as VersionedTransaction).signatures[0]).toEqual(
      decodeTx(built.bytes).tx.signatures[0],
    )
  })

  it('renders errors so the payout classifier can read them', async () => {
    const { conn, client } = setup()
    const built = await client.buildTransferTx(baseReq)
    conn.simulateValue = {
      err: { InstructionError: [4, { Custom: 1 }] },
      logs: [
        'Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [1]',
        'Program log: Error: insufficient funds',
        'Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x1',
      ],
      unitsConsumed: 5_000,
    }
    const noTokens = await client.simulate(built.bytes)
    expect(noTokens.ok).toBe(false)
    expect(noTokens.permanent).toBe(false)
    expect(noTokens.error).toContain('custom program error: 0x1')
    expect(noTokens.error).toContain('Program log: Error: insufficient funds')
    expect(classifyFailure(noTokens.error)).toBe('low_pool')

    conn.simulateValue = { err: 'AccountNotFound', logs: [], unitsConsumed: 0 }
    expect(classifyFailure((await client.simulate(built.bytes)).error)).toBe('low_gas')

    // AccountFrozen (0x11) is permanent when the logs attribute it to a token program…
    conn.simulateValue = {
      err: { InstructionError: [4, { Custom: 17 }] },
      logs: ['Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x11'],
    }
    expect(classifyFailure((await client.simulate(built.bytes)).error)).toBe('permanent')
    // …but a bare code with no failing program is not attributed (retried; the rebuild's simulation has logs)
    conn.simulateValue = { err: { InstructionError: [4, { Custom: 17 }] }, logs: [] }
    expect(classifyFailure((await client.simulate(built.bytes)).error)).toBe('transient')

    conn.simulateValue = { err: 'BlockhashNotFound', logs: [] }
    expect(classifyFailure((await client.simulate(built.bytes)).error)).toBe('transient')

    expect(renderTxError({ InsufficientFundsForRent: { account_index: 0 } })).toMatch(
      /InsufficientFundsForRent/,
    )
    expect(renderTxError({ InstructionError: [2, 'IllegalOwner'] })).toMatch(/^instruction 2: IllegalOwner/)
  })

  it('sends once with skipPreflight and no RPC retries; network errors are transient', async () => {
    const { conn, client } = setup()
    const built = await client.buildTransferTx(baseReq)
    expect(await client.sendRaw(built.bytes)).toBe(built.signature)
    expect(conn.callsTo('sendRawTransaction')[0]!.args[1]).toEqual({ skipPreflight: true, maxRetries: 0 })

    conn.sendError = new TypeError('fetch failed')
    await expect(client.sendRaw(built.bytes)).rejects.toBeInstanceOf(TransientChainError)
    conn.sendError = Object.assign(new Error('failed to send transaction: Invalid params: bad'), {
      code: -32602,
    })
    const err = await client.sendRaw(built.bytes).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(TransientChainError)
  })
})

// ── holdings ─────────────────────────────────────────────────────────────────

describe('getHoldings', () => {
  const multiCalls = (conn: StubConnection) =>
    conn.callsTo('getMultipleAccountsInfoAndContext').map((c) => ({
      keys: c.args[0] as string[],
      config: c.args[1] as { commitment: string; minContextSlot?: number },
    }))

  /** n owners, each holding i + 1 in its ATA */
  function manyOwners(conn: StubConnection, n: number, tag: number, mint = MINT) {
    return Array.from({ length: n }, (_, i) => {
      const seed = new Uint8Array(32)
      seed[0] = i % 256
      seed[1] = Math.floor(i / 256)
      seed[2] = tag
      const o = Keypair.fromSeed(seed).publicKey
      const program = mint.equals(LEGACY_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID
      putToken(conn, ata(o, mint, program), o, BigInt(i + 1), { mint })
      return o
    })
  }

  it('sums every token account of each owner, all read at one slot', async () => {
    const { conn, client } = setup()
    const carol = seeded(5).publicKey
    const dave = seeded(6).publicKey
    const erin = seeded(7).publicKey
    const frank = seeded(8).publicKey
    // ALICE: Token-2022 ATA with extensions (175 bytes) + an auxiliary 165-byte account
    putToken(conn, ata(ALICE), ALICE, 500n, { ext: true })
    putToken(conn, seeded(60).publicKey, ALICE, 20n)
    // BOB: extension-less account at the ATA (165 bytes) + a frozen one (still held)
    putToken(conn, ata(BOB), BOB, 7n)
    putToken(conn, seeded(61).publicKey, BOB, 3n, { state: AccountState.Frozen })
    // CAROL: no ATA, holds in two auxiliary accounts
    putToken(conn, seeded(62).publicKey, carol, 100n, { ext: true })
    putToken(conn, seeded(63).publicKey, carol, 23n)
    // DAVE: empty ATA, nothing elsewhere
    putToken(conn, ata(dave), dave, 0n, { ext: true })
    // ERIN: the account at her ATA address has owner field ALICE (legacy-style reassignment) → Alice's
    putToken(conn, ata(erin), ALICE, 999n)
    // FRANK: token-shaped data at his ATA address, but not owned by a token program → nothing
    conn.accounts.set(
      ata(frank).toBase58(),
      account(SystemProgram.programId, tokenAccountData(MINT, frank, 777n)),
    )
    // a LEGACY_MINT account of Alice's does not count for MINT
    putToken(conn, seeded(64).publicKey, ALICE, 5_000n, { mint: LEGACY_MINT })

    const owners = [ALICE, BOB, carol, dave, erin, frank].map((p) => p.toBase58())
    const res = await client.getHoldings([...owners, ALICE.toBase58(), 'not-an-address'], MINT.toBase58())

    expect(res.value.get(ALICE.toBase58())).toBe(500n + 20n + 999n)
    expect(res.value.get(BOB.toBase58())).toBe(10n)
    expect(res.value.get(carol.toBase58())).toBe(123n)
    expect(res.value.get(dave.toBase58())).toBe(0n)
    expect(res.value.get(erin.toBase58())).toBe(0n)
    expect(res.value.get(frank.toBase58())).toBe(0n)
    expect(res.value.get('not-an-address')).toBe(0n)
    expect(res.value.size).toBe(7)
    expect(res.slot).toBe(conn.slot)

    // discovery: one getTokenAccountsByOwner per valid owner
    const discovery = conn.callsTo('getTokenAccountsByOwner')
    expect(discovery.map((c) => c.args[0]).sort()).toEqual([...owners].sort())
    expect(discovery.every((c) => c.args[1] === MINT.toBase58() && c.args[2] === 'confirmed')).toBe(true)
    // one read of every discovered address (each once), no earlier than the discovery view
    const reads = multiCalls(conn)
    expect(reads.length).toBe(1)
    expect(reads[0]!.config).toEqual({ commitment: 'confirmed', minContextSlot: conn.slot - 3 })
    const expected = [
      ata(ALICE),
      seeded(60).publicKey,
      ata(erin),
      ata(BOB),
      seeded(61).publicKey,
      ata(carol),
      seeded(62).publicKey,
      seeded(63).publicKey,
      ata(dave),
      ata(frank),
    ].map((p) => p.toBase58())
    expect([...reads[0]!.keys].sort()).toEqual([...expected].sort())
  })

  it('takes amounts only from the one-slot read, never from discovery', async () => {
    const { conn, client } = setup()
    const carol = seeded(5).publicKey
    putToken(conn, seeded(62).publicKey, carol, 100n)
    // tokens leave the account between the discovery answer and the read
    conn.afterTokenAccountsByOwner = () => putToken(conn, seeded(62).publicKey, carol, 1n)
    const res = await client.getHoldings([carol.toBase58()], MINT.toBase58())
    expect(res.value.get(carol.toBase58())).toBe(1n)
  })

  it('an account whose owner changed after discovery no longer counts for the old owner', async () => {
    const { conn, client } = setup()
    const carol = seeded(5).publicKey
    const outsider = seeded(9).publicKey
    const moved = seeded(62).publicKey
    putToken(conn, ata(carol), carol, 5n)
    putToken(conn, moved, carol, 100n)
    putToken(conn, ata(BOB), BOB, 7n)
    const owners = [carol, BOB].map((p) => p.toBase58())
    expect((await client.getHoldings(owners, MINT.toBase58())).value.get(carol.toBase58())).toBe(105n)

    // SetAuthority(owner) to someone who is not an entrant: the cached list still has it, the read says no
    putToken(conn, moved, outsider, 100n)
    const second = await client.getHoldings(owners, MINT.toBase58())
    expect(second.value.get(carol.toBase58())).toBe(5n)
    expect(second.value.get(BOB.toBase58())).toBe(7n)
    expect(second.value.has(outsider.toBase58())).toBe(false)
    // …or to another entrant: counted once, for its owner at the read slot
    putToken(conn, moved, BOB, 100n)
    const third = await client.getHoldings(owners, MINT.toBase58())
    expect(third.value.get(carol.toBase58())).toBe(5n)
    expect(third.value.get(BOB.toBase58())).toBe(107n)
    expect(conn.callsTo('getTokenAccountsByOwner').length).toBe(2) // the lists were cached
  })

  it('refreshes an owner’s account list once it is an hour old', async () => {
    const { conn, client, clock } = setup()
    const carol = seeded(5).publicKey
    putToken(conn, ata(carol), carol, 5n)
    const get = async () =>
      (await client.getHoldings([carol.toBase58()], MINT.toBase58())).value.get(carol.toBase58())
    expect(await get()).toBe(5n)
    putToken(conn, seeded(62).publicKey, carol, 40n) // a new account after discovery
    clock.now += 59 * 60_000
    expect(await get()).toBe(5n) // not discovered yet
    expect(conn.callsTo('getTokenAccountsByOwner').length).toBe(1)
    clock.now += 60_000
    expect(await get()).toBe(45n)
    expect(conn.callsTo('getTokenAccountsByOwner').length).toBe(2)
  })

  it('re-issues every chunk until they answer at one slot, raising minContextSlot', async () => {
    const { conn, client } = setup()
    const owners = manyOwners(conn, 150, 1)
    conn.multiSlots = [5_000, 5_001, 5_001, 5_001]
    const res = await client.getHoldings(
      owners.map((o) => o.toBase58()),
      MINT.toBase58(),
    )
    const reads = multiCalls(conn)
    expect(reads.map((r) => r.keys.length)).toEqual([100, 50, 100, 50])
    expect(reads.map((r) => r.config.minContextSlot)).toEqual([4_997, 4_997, 5_001, 5_001])
    expect(res.slot).toBe(5_001)
    owners.forEach((o, i) => expect(res.value.get(o.toBase58())).toBe(BigInt(i + 1)))
  })

  it('retries when a node has not reached minContextSlot; other RPC errors are transient at once', async () => {
    const { conn, client } = setup()
    const owners = manyOwners(conn, 150, 2).map((o) => o.toBase58())
    conn.multiErrors = [
      Object.assign(new Error('Minimum context slot has not been reached'), { code: -32016 }),
    ]
    const res = await client.getHoldings(owners, MINT.toBase58())
    expect(multiCalls(conn).length).toBe(4)
    expect(res.slot).toBe(conn.slot)
    expect(res.value.get(owners[149]!)).toBe(150n)

    conn.calls = []
    conn.multiErrors = [new Error('429 Too Many Requests')]
    await expect(client.getHoldings(owners, MINT.toBase58())).rejects.toBeInstanceOf(TransientChainError)
    expect(multiCalls(conn).length).toBe(2) // one attempt, both chunks
  })

  it('gives up with TransientChainError when the chunks never agree on a slot', async () => {
    const { conn, client } = setup()
    const owners = manyOwners(conn, 150, 3).map((o) => o.toBase58())
    conn.multiSlots = Array.from({ length: 20 }, (_, i) => 6_000 + i)
    const err = await client.getHoldings(owners, MINT.toBase58()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TransientChainError)
    expect((err as Error).message).toMatch(/one slot after 5 attempts/)
    expect(multiCalls(conn).length).toBe(10) // 1 + 4 retries, both chunks each time
  })

  it('reads legacy SPL token accounts via the legacy program ATA and chunks by 100', async () => {
    const { conn, client } = setup()
    const owners = manyOwners(conn, 250, 77, LEGACY_MINT)
    const res = await client.getHoldings(
      owners.map((o) => o.toBase58()),
      LEGACY_MINT.toBase58(),
    )
    expect(multiCalls(conn).map((c) => c.keys.length)).toEqual([100, 100, 50])
    expect(multiCalls(conn)[0]!.keys[0]).toBe(ata(owners[0]!, LEGACY_MINT, TOKEN_PROGRAM_ID).toBase58())
    expect(conn.callsTo('getTokenAccountsByOwner').length).toBe(250)
    owners.forEach((o, i) => expect(res.value.get(o.toBase58())).toBe(BigInt(i + 1)))
    expect(res.slot).toBe(conn.slot)
    // a second round reuses the discovered lists
    await client.getHoldings(
      owners.map((o) => o.toBase58()),
      LEGACY_MINT.toBase58(),
    )
    expect(conn.callsTo('getTokenAccountsByOwner').length).toBe(250)
  })

  it('with no valid owners it reads nothing and reports the current slot', async () => {
    const { conn, client } = setup()
    const res = await client.getHoldings(['nope', 'nope'], MINT.toBase58())
    expect(res).toEqual({ value: new Map([['nope', 0n]]), slot: conn.slot })
    expect(multiCalls(conn).length).toBe(0)
  })

  it('decodeTokenAccountAmount checks mint, owner and that the data is an initialized token account', () => {
    const data = tokenAccountData(MINT, ALICE, 1_234n, true)
    expect(data.length).toBe(175)
    expect(decodeTokenAccountAmount(data, MINT, ALICE)).toBe(1_234n)
    expect(decodeTokenAccountAmount(data, MINT)).toBe(1_234n)
    expect(decodeTokenAccountAmount(data, LEGACY_MINT, ALICE)).toBeNull()
    expect(decodeTokenAccountAmount(data, MINT, BOB)).toBeNull()
    expect(decodeTokenAccountAmount(data.subarray(0, 100), MINT)).toBeNull()
    const frozen = tokenAccountData(MINT, ALICE, 9n, false, AccountState.Frozen)
    expect(decodeTokenAccountAmount(frozen, MINT, ALICE)).toBe(9n)
    expect(decodeTokenAccount(frozen)!.state).toBe(AccountState.Frozen)
    const uninitialized = tokenAccountData(MINT, ALICE, 9n, false, AccountState.Uninitialized)
    expect(decodeTokenAccountAmount(uninitialized, MINT, ALICE)).toBeNull()
    // a multisig (355 bytes) or a Token-2022 mint whose leading bytes happen to look like mint + owner
    const lookalike = (size: number, typeByte: number) => {
      const b = Buffer.alloc(size)
      tokenAccountData(MINT, ALICE, 1n << 60n).copy(b)
      b[ACCOUNT_SIZE] = typeByte
      return b
    }
    expect(decodeTokenAccountAmount(lookalike(355, AccountType.Account), MINT, ALICE)).toBeNull()
    expect(decodeTokenAccountAmount(lookalike(200, AccountType.Mint), MINT, ALICE)).toBeNull()
    expect(decodeTokenAccountAmount(lookalike(200, AccountType.Account), MINT, ALICE)).toBe(1n << 60n)
  })

  it('getTokenBalance sums every account of the owner for the mint', async () => {
    const { conn, client } = setup()
    putToken(conn, seeded(100).publicKey, ALICE, 10n, { ext: true })
    putToken(conn, seeded(101).publicKey, ALICE, 5n)
    expect(await client.getTokenBalance(ALICE.toBase58(), MINT.toBase58(), 'finalized')).toEqual({
      value: 15n,
      slot: conn.slot - 3,
    })
    expect(conn.callsTo('getTokenAccountsByOwner')[0]!.args[2]).toBe('finalized')
    expect(await client.getTokenBalance(BOB.toBase58(), MINT.toBase58())).toEqual({
      value: 0n,
      slot: conn.slot - 3,
    })
  })
})

describe('getAtaBalance', () => {
  it('reads the owner’s ATA only, at the answering slot', async () => {
    const { conn, client } = setup()
    putToken(conn, ata(ALICE), ALICE, 500n, { ext: true })
    putToken(conn, seeded(60).publicKey, ALICE, 20n) // not the ATA → ignored
    expect(await client.getAtaBalance(ALICE.toBase58(), MINT.toBase58())).toEqual({
      value: 500n,
      slot: conn.slot,
    })
    const call = conn.callsTo('getAccountInfoAndContext')[0]!
    expect(call.args).toEqual([ata(ALICE).toBase58(), 'confirmed'])
    await client.getAtaBalance(ALICE.toBase58(), MINT.toBase58(), 'finalized')
    expect(conn.callsTo('getAccountInfoAndContext')[1]!.args[1]).toBe('finalized')
  })

  it('is 0 when the ATA is missing, not the owner’s, frozen, or not a token account', async () => {
    const { conn, client } = setup()
    const dave = seeded(6).publicKey
    const erin = seeded(7).publicKey
    const frank = seeded(8).publicKey
    putToken(conn, ata(erin), ALICE, 999n) // owner field reassigned
    putToken(conn, ata(dave), dave, 50n, { state: AccountState.Frozen })
    conn.accounts.set(
      ata(frank).toBase58(),
      account(SystemProgram.programId, tokenAccountData(MINT, frank, 7n)),
    )
    for (const o of [BOB, erin, dave, frank]) {
      expect(await client.getAtaBalance(o.toBase58(), MINT.toBase58())).toEqual({
        value: 0n,
        slot: conn.slot,
      })
    }
  })

  it('derives the ATA with the mint’s own program', async () => {
    const { conn, client } = setup()
    putToken(conn, ata(ALICE, LEGACY_MINT, TOKEN_PROGRAM_ID), ALICE, 9n, { mint: LEGACY_MINT })
    expect((await client.getAtaBalance(ALICE.toBase58(), LEGACY_MINT.toBase58())).value).toBe(9n)
  })
})

describe('getOwnerTokenDeltas', () => {
  const bal = (accountIndex: number, owner: PublicKey | undefined, amount: bigint, mint = MINT) => ({
    accountIndex,
    mint: mint.toBase58(),
    ...(owner ? { owner: owner.toBase58() } : {}),
    uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null, uiAmountString: '' },
  })

  function txResponse(meta: object | null) {
    return { slot: 4_321, blockTime: null, transaction: { message: {}, signatures: ['sig'] }, meta }
  }

  it('nets post − pre over every token account of the owner, per mint', async () => {
    const { conn, client } = setup()
    conn.txs.set(
      'swap-sig',
      txResponse({
        fee: 5_000,
        err: null,
        preBalances: [],
        postBalances: [],
        preTokenBalances: [
          bal(1, ALICE, 100n), //                     +50
          bal(2, ALICE, 20n), //                      closed in the tx: post = 0 → −20
          bal(3, BOB, 50n), //                        not Alice's
          bal(4, ALICE, 5n, LEGACY_MINT), //          unchanged → omitted
          bal(6, ALICE, 10n), //                      moved to Bob in the tx → −10 for Alice
          bal(7, ALICE, 1_000n, LEGACY_MINT), //      −400 of the other mint
        ],
        postTokenBalances: [
          bal(1, ALICE, 150n),
          bal(3, BOB, 0n),
          bal(4, ALICE, 5n, LEGACY_MINT),
          bal(5, ALICE, 30n), //                      created in the tx: pre = 0 → +30
          bal(6, BOB, 10n),
          bal(7, ALICE, 600n, LEGACY_MINT),
        ],
      }),
    )
    const res = await client.getOwnerTokenDeltas('swap-sig', ALICE.toBase58())
    expect(res).toEqual({
      signature: 'swap-sig',
      slot: 4_321,
      err: null,
      deltas: new Map([
        [MINT.toBase58(), 50n - 20n - 10n + 30n],
        [LEGACY_MINT.toBase58(), -400n],
      ]),
    })
    const bob = await client.getOwnerTokenDeltas('swap-sig', BOB.toBase58())
    expect(bob!.deltas).toEqual(new Map([[MINT.toBase58(), -50n + 10n]]))
    expect(conn.callsTo('getTransaction')[0]!.args).toEqual([
      'swap-sig',
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ])
  })

  it('renders a failed tx’s error (its balances did not move); null for an unknown signature', async () => {
    const { conn, client } = setup()
    conn.txs.set(
      'failed',
      txResponse({
        err: { InstructionError: [3, { Custom: 1 }] },
        preTokenBalances: [bal(1, ALICE, 100n)],
        postTokenBalances: [bal(1, ALICE, 100n)],
      }),
    )
    const res = await client.getOwnerTokenDeltas('failed', ALICE.toBase58())
    expect(res!.err).toContain('custom program error: 0x1')
    expect(res!.deltas.size).toBe(0)
    expect(await client.getOwnerTokenDeltas('unknown', ALICE.toBase58())).toBeNull()
  })

  it('never guesses: missing meta, token balances or owners are transient', async () => {
    const { conn, client } = setup()
    conn.txs.set('no-meta', txResponse(null))
    conn.txs.set('no-balances', txResponse({ err: null, preTokenBalances: null, postTokenBalances: [] }))
    conn.txs.set(
      'no-owner',
      txResponse({ err: null, preTokenBalances: [bal(1, undefined, 1n)], postTokenBalances: [] }),
    )
    for (const sig of ['no-meta', 'no-balances', 'no-owner']) {
      await expect(client.getOwnerTokenDeltas(sig, ALICE.toBase58())).rejects.toBeInstanceOf(
        TransientChainError,
      )
    }
    conn.getTransaction = async () => {
      throw new Error('fetch failed')
    }
    await expect(client.getOwnerTokenDeltas('x', ALICE.toBase58())).rejects.toBeInstanceOf(
      TransientChainError,
    )
  })
})

// ── statuses / heights / fees ────────────────────────────────────────────────

describe('signature statuses', () => {
  it('passes through the response context slot and renders errors', async () => {
    const { conn, client } = setup()
    conn.statusContextSlots = [777]
    conn.statusValues = [
      { slot: 700, confirmations: null, err: null, confirmationStatus: 'finalized' },
      null,
      {
        slot: 701,
        confirmations: 3,
        err: { InstructionError: [4, { Custom: 1 }] },
        confirmationStatus: 'confirmed',
      },
    ]
    const res = await client.getSignatureStatuses(['a', 'b', 'c'])
    expect(res.contextSlot).toBe(777)
    expect(res.statuses[0]).toEqual({ slot: 700, confirmationStatus: 'finalized', err: null })
    expect(res.statuses[1]).toBeNull()
    expect(res.statuses[2]!.confirmationStatus).toBe('confirmed')
    expect(res.statuses[2]!.err).toContain('custom program error: 0x1')
    expect(conn.callsTo('getSignatureStatuses')[0]!.args[1]).toEqual({ searchTransactionHistory: true })
  })

  it('chunks by 256 and reports the oldest context slot', async () => {
    const { conn, client } = setup()
    conn.statusContextSlots = [900, 850]
    const sigs = Array.from({ length: 300 }, (_, i) => `sig${i}`)
    const res = await client.getSignatureStatuses(sigs)
    expect(conn.callsTo('getSignatureStatuses').map((c) => (c.args[0] as string[]).length)).toEqual([256, 44])
    expect(res.statuses.length).toBe(300)
    expect(res.contextSlot).toBe(850)
  })

  it('getHeightAndSlot reads block height and slot from one getEpochInfo response', async () => {
    const { conn, client } = setup()
    expect(await client.getHeightAndSlot('finalized')).toEqual({ blockHeight: 300_123, slot: 345_678 })
    expect(conn.callsTo('getEpochInfo')[0]!.args[0]).toBe('finalized')
  })
})

describe('estimatePriorityFee', () => {
  it('uses the 75th percentile of non-zero GLOBAL recent fees with a 1,000 floor', async () => {
    const { conn, client } = setup()
    conn.prioritizationFees = [0, 0, 100, 2_000, 3_000, 4_000, 5_000]
    expect(await client.estimatePriorityFee()).toBe(4_000)
    // no account filter: the market's recent fees, not just txs that happened to lock PRIZE
    const call = conn.callsTo('getRecentPrioritizationFees')[0]!
    expect(call.args[0]).toBeUndefined()
    conn.prioritizationFees = [0, 0, 0]
    expect(await client.estimatePriorityFee()).toBe(1_000)
    conn.prioritizationFees = [10, 20]
    expect(await client.estimatePriorityFee()).toBe(1_000)
    expect(percentile75NonZero([1, 2, 3, 4])).toBe(3)
    expect(percentile75NonZero([0, 7_000, 1_000, 3_000, 2_000, 0])).toBe(3_000)
  })

  it('returns the configured fallback when the RPC cannot answer', async () => {
    const { conn, client } = setup()
    conn.getRecentPrioritizationFees = async () => {
      throw new Error('503 Service Unavailable')
    }
    expect(await client.estimatePriorityFee()).toBe(20_000)
  })

  it('prefers the Helius estimate on Helius endpoints and falls back when it fails', async () => {
    let body: unknown = null
    let fail = false
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      if (fail) throw new Error('network down')
      body = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { priorityFeeEstimate: 12_345.2 } }),
      )
    }
    const { conn, client } = setup({ fetch: fakeFetch })
    conn.rpcEndpoint = 'https://devnet.helius-rpc.com/?api-key=test'
    conn.prioritizationFees = [7_000]
    expect(await client.estimatePriorityFee()).toBe(12_346)
    expect(body).toMatchObject({
      method: 'getPriorityFeeEstimate',
      params: [{ options: { priorityLevel: 'High' } }],
    })
    expect(conn.callsTo('getRecentPrioritizationFees').length).toBe(0)
    fail = true
    expect(await client.estimatePriorityFee()).toBe(7_000)
  })
})

// ── parsed payout transactions ───────────────────────────────────────────────

describe('parsePayoutTx', () => {
  const prizeAta = ata(PRIZE.publicKey)
  const aliceAta = ata(ALICE)
  const key = (pubkey: PublicKey) => ({ pubkey, signer: false, writable: true })
  const bal = (accountIndex: number, owner: PublicKey, amount: bigint, mint = MINT) => ({
    accountIndex,
    mint: mint.toBase58(),
    owner: owner.toBase58(),
    uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null },
  })

  function parsedTx(opts: { memoIx: boolean; err?: unknown }): ParsedTransactionWithMeta {
    const instructions: unknown[] = [
      {
        program: 'spl-associated-token-account',
        programId: ASSOCIATED_TOKEN_PROGRAM_ID,
        parsed: {
          type: 'createIdempotent',
          info: { account: aliceAta.toBase58(), wallet: ALICE.toBase58(), mint: MINT.toBase58() },
        },
      },
      ...(opts.memoIx
        ? [{ program: 'spl-memo', programId: MEMO_PROGRAM_ID, parsed: 'scratchy:devnet-test:42' }]
        : []),
      {
        program: 'spl-token-2022',
        programId: TOKEN_2022_PROGRAM_ID,
        parsed: {
          type: 'transferChecked',
          info: { source: prizeAta.toBase58(), destination: aliceAta.toBase58(), mint: MINT.toBase58() },
        },
      },
    ]
    return {
      slot: 4_242,
      blockTime: null,
      transaction: {
        signatures: ['sig'],
        message: {
          accountKeys: [key(PRIZE.publicKey), key(prizeAta), key(aliceAta), key(MINT)],
          instructions,
          recentBlockhash: BLOCKHASH,
        },
      },
      meta: {
        fee: 5_000,
        err: opts.err ?? null,
        preBalances: [],
        postBalances: [],
        logMessages: ['Program log: Memo (len 23): "scratchy:devnet-test:42"'],
        preTokenBalances: [bal(1, PRIZE.publicKey, 1_000_000n), bal(3, BOB, 5n, LEGACY_MINT)],
        postTokenBalances: [bal(1, PRIZE.publicKey, 987_500n), bal(2, ALICE, 12_500n)],
      },
    } as unknown as ParsedTransactionWithMeta
  }

  it('extracts memo, recipient and exact deltas for the payout mint', () => {
    const p = parsePayoutTx('sig', parsedTx({ memoIx: true }), MINT.toBase58(), PRIZE.publicKey.toBase58())
    expect(p).toEqual({
      signature: 'sig',
      slot: 4_242,
      err: null,
      memo: 'scratchy:devnet-test:42',
      recipientDeltaRaw: 12_500n,
      senderDeltaRaw: -12_500n,
      recipientOwner: ALICE.toBase58(),
    })
  })

  it('falls back to the memo program log and renders on-chain errors', () => {
    const p = parsePayoutTx(
      'sig',
      parsedTx({ memoIx: false, err: { InstructionError: [4, { Custom: 1 }] } }),
      MINT.toBase58(),
      PRIZE.publicKey.toBase58(),
    )
    expect(p.memo).toBe('scratchy:devnet-test:42')
    expect(p.err).toContain('custom program error: 0x1')
  })
})

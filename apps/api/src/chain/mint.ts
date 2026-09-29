import {
  AccountState,
  ExtensionType,
  getDefaultAccountState,
  getTransferHook,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token'
import { PublicKey, type AccountInfo, type Commitment, type Connection } from '@solana/web3.js'
import { TransientChainError, type MintInfo } from './types'

/**
 * Mint inspection (plan "mint scan"): which token program owns a mint, its decimals/supply, and which
 * Token-2022 extensions it carries. The real PUMP mint is Token-2022 with a transferHook extension whose
 * program is currently unset — so transfers must be hook-aware, and the boot scan must notice if a hook
 * program ever appears. Extensions that change transfer semantics (fees, permanent delegate, frozen-by-
 * default accounts, non-transferable, confidential transfers, pausable) are reported as blocking: the
 * payout math assumes "send X raw → recipient receives exactly X", which those break. Mint extensions
 * cannot be added after initialization, so an extension this library does not know is also blocking.
 */

/** extensions that make a mint unusable for exact-amount payouts (names as in spl-token ExtensionType) */
export const BLOCKING_EXTENSIONS: readonly ExtensionType[] = [
  ExtensionType.TransferFeeConfig,
  ExtensionType.PermanentDelegate,
  ExtensionType.NonTransferable,
  ExtensionType.ConfidentialTransferMint,
  ExtensionType.PausableConfig,
]

export function extensionName(t: number): string {
  const name = (ExtensionType as unknown as Record<number, string | undefined>)[t]
  return name ?? `Unknown(${t})`
}

/**
 * Walk a Token-2022 TLV region and list the extension types present. Stops at the first
 * Uninitialized (type 0) entry, as the program does; tolerant of trailing padding.
 */
export function listExtensionTypes(tlvData: Uint8Array): number[] {
  const view = new DataView(tlvData.buffer, tlvData.byteOffset, tlvData.byteLength)
  const out: number[] = []
  let i = 0
  while (i + 4 <= tlvData.length) {
    const type = view.getUint16(i, true)
    const len = view.getUint16(i + 2, true)
    if (type === 0) break
    out.push(type)
    i += 4 + len
  }
  return out
}

/** Decode a fetched mint account (pure — no RPC). Throws if it is not an SPL / Token-2022 mint. */
export function decodeMintAccount(address: string, info: AccountInfo<Buffer> | null): MintInfo {
  if (!info) throw new Error(`mint ${address} not found`)
  const isToken2022 = info.owner.equals(TOKEN_2022_PROGRAM_ID)
  if (!isToken2022 && !info.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`mint ${address} is owned by ${info.owner.toBase58()}, not an SPL token program`)
  }
  const mint = unpackMint(new PublicKey(address), info, info.owner)
  if (!mint.isInitialized) throw new Error(`mint ${address} is not initialized`)

  const types = isToken2022 ? listExtensionTypes(mint.tlvData) : []
  const extensions = types.map(extensionName)

  const hook = isToken2022 ? getTransferHook(mint) : null
  const transferHookProgram =
    hook && !hook.programId.equals(PublicKey.default) ? hook.programId.toBase58() : null

  const blocking: string[] = []
  for (const t of types) {
    if (BLOCKING_EXTENSIONS.includes(t)) blocking.push(extensionName(t))
    else if (t === ExtensionType.DefaultAccountState) {
      const das = getDefaultAccountState(mint)
      if (das && das.state === AccountState.Frozen) blocking.push(extensionName(t))
    } else if (!(t in ExtensionType)) blocking.push(extensionName(t))
  }

  return {
    address,
    decimals: mint.decimals,
    tokenProgram: info.owner.toBase58(),
    isToken2022,
    supply: mint.supply,
    extensions,
    transferHookProgram,
    blockingExtensions: blocking,
  }
}

/** Fetch and decode a mint. RPC failures → TransientChainError; a missing / non-mint account → Error. */
export async function inspectMint(
  connection: Pick<Connection, 'getAccountInfo'>,
  mint: string,
  commitment: Commitment = 'confirmed',
): Promise<MintInfo> {
  const pk = new PublicKey(mint)
  let info: AccountInfo<Buffer> | null
  try {
    info = await connection.getAccountInfo(pk, commitment)
  } catch (e) {
    throw new TransientChainError(`getAccountInfo(mint ${mint}) failed: ${(e as Error).message}`, e)
  }
  return decodeMintAccount(mint, info)
}

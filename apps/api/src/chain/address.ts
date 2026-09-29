import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'

/**
 * Wallet address validation (PLAN §7 / plan "Holdings: validation"). A player wallet must be:
 *  - canonical base58 that decodes to exactly 32 bytes, and
 *  - an ed25519 point ON the curve, i.e. a key someone can sign with.
 * Off-curve addresses are PDAs — AMM / lending vaults, pool authorities, multisig vaults — which hold
 * $SCRATCHY but are not players, so they are rejected (documented flag: this also excludes Squads
 * multisig vault holders). Pure functions, no RPC.
 */

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** decode a canonical base58 32-byte key, or null (no throw) */
function decodeKey(s: string): Uint8Array | null {
  if (!BASE58_RE.test(s)) return null
  let bytes: Uint8Array
  try {
    bytes = bs58.decode(s)
  } catch {
    return null
  }
  if (bytes.length !== 32) return null
  // reject non-canonical spellings (the same bytes must re-encode to the same string)
  if (bs58.encode(bytes) !== s) return null
  return bytes
}

/** any 32-byte public key, on or off curve (programs, mints, PDAs included) */
export function isValidPublicKey(s: unknown): s is string {
  return typeof s === 'string' && decodeKey(s) !== null
}

/** a signable wallet: base58 → 32 bytes AND on the ed25519 curve (PDAs rejected) */
export function isValidWalletAddress(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const bytes = decodeKey(s)
  return bytes !== null && PublicKey.isOnCurve(bytes)
}

/** trim user input and return the canonical wallet address, or null if it is not a valid wallet */
export function normalizeWalletAddress(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const s = input.trim()
  return isValidWalletAddress(s) ? s : null
}

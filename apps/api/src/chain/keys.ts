import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { readFileSync } from 'node:fs'
import type { ClusterName } from './types'

/**
 * Server-held signer loading (plan "Keys/cluster"; PLAN §5 hot wallet).
 *  - loadKeypair: a 64-byte secret key as base58 (wallet export) or a JSON byte array (solana-keygen).
 *  - keypairFromEnv: the loaded key MUST match the separately configured public address, so a
 *    mis-pasted key can never sign as the wrong wallet.
 *  - loadKeypairFile: key files are a devnet/localnet-only convenience (`.devnet/*.json`); refused on
 *    any other cluster so a mainnet key never lives in a file next to the repo.
 * Error messages never contain secret material (JSON/base58 parser errors can echo their input, so they
 * are replaced, never chained as `cause`).
 */

const SECRET_KEY_BYTES = 64

export class KeyLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyLoadError'
  }
}

function parseSecretBytes(secret: string): Uint8Array {
  const s = secret.trim()
  if (s === '') throw new KeyLoadError('secret key is empty')
  if (s.startsWith('[')) {
    let arr: unknown
    try {
      arr = JSON.parse(s)
    } catch {
      throw new KeyLoadError('secret key looks like a JSON array but is not valid JSON')
    }
    if (
      !Array.isArray(arr) ||
      !arr.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)
    ) {
      throw new KeyLoadError('secret key JSON must be an array of byte values (0–255)')
    }
    return Uint8Array.from(arr as number[])
  }
  try {
    return bs58.decode(s)
  } catch {
    throw new KeyLoadError('secret key is neither a JSON byte array nor valid base58')
  }
}

/** Parse a 64-byte ed25519 secret key given as base58 or a JSON byte array. */
export function loadKeypair(secret: string): Keypair {
  const bytes = parseSecretBytes(secret)
  if (bytes.length !== SECRET_KEY_BYTES) {
    throw new KeyLoadError(`secret key must be ${SECRET_KEY_BYTES} bytes (got ${bytes.length})`)
  }
  try {
    return Keypair.fromSecretKey(bytes) // validates that the embedded public half matches
  } catch {
    throw new KeyLoadError('secret key is invalid (its public half does not match its private half)')
  }
}

/** Load a signer from an env secret and require it to be `expectedAddress`. */
export function keypairFromEnv(secret: string, expectedAddress: string, label = 'wallet'): Keypair {
  const kp = loadKeypair(secret)
  const actual = kp.publicKey.toBase58()
  if (actual !== expectedAddress.trim()) {
    throw new KeyLoadError(
      `${label} key mismatch: the configured secret belongs to ${actual}, expected ${expectedAddress.trim()}`,
    )
  }
  return kp
}

/** Read a solana-keygen style key file. Devnet/localnet only. */
export function loadKeypairFile(path: string, cluster: ClusterName | string): Keypair {
  if (cluster !== 'devnet' && cluster !== 'localnet') {
    throw new KeyLoadError(
      `refusing to load a key file on cluster "${cluster}": key files are a devnet/localnet-only convenience`,
    )
  }
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (e) {
    throw new KeyLoadError(`cannot read key file ${path}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`)
  }
  return loadKeypair(content)
}

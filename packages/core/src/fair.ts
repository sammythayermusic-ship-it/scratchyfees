import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { jackpotFromUniform53, tierFromUniform53, type TierId } from './odds'

/**
 * PLAN.md §4 — Provably fair RNG. Isomorphic (Node + browser): the /fair page runs this exact code.
 *
 * 1. Before each round: serverSeed = 32 random bytes; publish sha256(serverSeed).
 * 2. Ticket outcome: HMAC_SHA256(key = serverSeed, msg = `${wallet}:${roundId}:${ticketIdx}`)
 *      bytes 0–7  → big-endian uint64 → >> 11 → x ∈ [0, 2^53) → u = x / 2^53 → odds table
 *      bytes 8–15 → big-endian uint64 → >> 11 → y ∈ [0, 2^53) → jackpot hit iff y / 2^53 < 1 / JACKPOT_ODDS
 * 3. serverSeed is revealed when the round ends; anyone can recompute every ticket.
 *
 * wallet   = base58 address exactly as pasted/stored
 * roundId  = the integer round id shown on the site
 * ticketIdx = 0-based index of the ticket within that wallet's entry
 */

export const SEED_BYTES = 32

export function generateServerSeed(): Uint8Array {
  return randomBytes(SEED_BYTES)
}

export function seedToHex(seed: Uint8Array): string {
  return bytesToHex(seed)
}

export function seedFromHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new RangeError('server seed must be 32 bytes of hex')
  return hexToBytes(clean)
}

/** Commitment published before the round: sha256(serverSeed) as lowercase hex. */
export function seedCommitment(seed: Uint8Array): string {
  return bytesToHex(sha256(seed))
}

export function verifySeedCommitment(seedHex: string, commitmentHex: string): boolean {
  return seedCommitment(seedFromHex(seedHex)) === commitmentHex.trim().toLowerCase()
}

export function ticketMessage(wallet: string, roundId: number | bigint, ticketIdx: number | bigint): string {
  return `${wallet}:${roundId.toString()}:${ticketIdx.toString()}`
}

export function ticketDigest(
  seed: Uint8Array,
  wallet: string,
  roundId: number | bigint,
  ticketIdx: number | bigint,
): Uint8Array {
  return hmac(sha256, seed, utf8ToBytes(ticketMessage(wallet, roundId, ticketIdx)))
}

/** Read 8 bytes at `offset` as a big-endian uint64 and keep the top 53 bits (uint64 >> 11). */
export function uniform53At(digest: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 8 > digest.length) throw new RangeError('digest too short')
  let v = 0n
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(digest[offset + i]!)
  return v >> 11n
}

export interface TicketDerivation {
  tier: TierId
  jackpot: boolean
  /** hex of the HMAC digest (useful for audits) */
  digestHex: string
  /** x/2^53 for display in the verifier */
  u: number
  /** y/2^53 for display in the verifier */
  uJackpot: number
}

export function deriveTicket(
  seed: Uint8Array,
  wallet: string,
  roundId: number | bigint,
  ticketIdx: number | bigint,
  jackpotOdds: bigint,
): TicketDerivation {
  const digest = ticketDigest(seed, wallet, roundId, ticketIdx)
  const x = uniform53At(digest, 0)
  const y = uniform53At(digest, 8)
  return {
    tier: tierFromUniform53(x),
    jackpot: jackpotFromUniform53(y, jackpotOdds),
    digestHex: bytesToHex(digest),
    u: Number(x) / 2 ** 53,
    uJackpot: Number(y) / 2 ** 53,
  }
}

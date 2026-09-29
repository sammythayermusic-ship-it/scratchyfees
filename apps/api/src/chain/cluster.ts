import type { Connection } from '@solana/web3.js'
import { TransientChainError } from './types'

/**
 * Cluster identity by genesis hash (plan "Keys/cluster"). An RPC URL is only a claim; the genesis hash
 * is what the node actually serves. The API refuses to start when the RPC's genesis does not match the
 * configured SOLANA_CLUSTER, so a devnet config can never talk to mainnet (and vice versa) by accident.
 * localnet = any genesis that is not one of the public clusters (solana-test-validator, LiteSVM, …).
 */

export const GENESIS_HASHES = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
} as const

export type RpcClusterName = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet'
/** clusters the Solana chain client may be configured for */
export type SolanaClusterName = 'devnet' | 'localnet' | 'mainnet-beta'

/** which cluster a genesis hash belongs to (unknown hashes are a local validator) */
export function clusterFromGenesis(hash: string): RpcClusterName {
  for (const [name, h] of Object.entries(GENESIS_HASHES)) {
    if (h === hash) return name as RpcClusterName
  }
  return 'localnet'
}

/**
 * Throws unless `connection` serves the `expected` cluster. Returns the genesis hash on success.
 * RPC trouble surfaces as TransientChainError (retry); a mismatch is a plain Error (refuse to boot).
 */
export async function verifyCluster(
  connection: Pick<Connection, 'getGenesisHash'>,
  expected: SolanaClusterName,
): Promise<string> {
  let hash: string
  try {
    hash = await connection.getGenesisHash()
  } catch (e) {
    throw new TransientChainError(`getGenesisHash failed: ${(e as Error).message}`, e)
  }
  const actual = clusterFromGenesis(hash)
  if (actual !== expected) {
    throw new Error(
      `cluster mismatch: configured for ${expected} but the RPC serves ${actual} (genesis ${hash}); refusing to continue`,
    )
  }
  return hash
}

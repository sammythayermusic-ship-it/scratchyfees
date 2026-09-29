import type pg from 'pg'

/**
 * Single-leader guard for background jobs (round engine, sweeper): a session-level Postgres advisory lock
 * held on a dedicated connection. A deploy overlap or a second instance simply fails to acquire it.
 */
export const LOCK_KEYS = {
  roundEngine: 7_700_001,
  sweeper: 7_700_002,
  reconciler: 7_700_003,
} as const

export type ReleaseLock = () => Promise<void>

export async function tryAdvisoryLock(pool: pg.Pool, key: number): Promise<ReleaseLock | null> {
  const client = await pool.connect()
  try {
    const res = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [key])
    if (!res.rows[0]?.ok) {
      client.release()
      return null
    }
  } catch (e) {
    client.release()
    throw e
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [key])
    } finally {
      client.release()
    }
  }
}

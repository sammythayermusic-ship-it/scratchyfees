import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { resolve } from 'node:path'
import pg from 'pg'
import * as schema from './schema'

// int8 → bigint everywhere (pg returns int8 as strings by default; Drizzle bigint columns expect bigint)
pg.types.setTypeParser(20, (v) => BigInt(v))

export type Db = NodePgDatabase<typeof schema>

export interface Database {
  db: Db
  pool: pg.Pool
  close(): Promise<void>
}

export function createDatabase(url: string, max = 10): Database {
  const pool = new pg.Pool({ connectionString: url, max })
  const db = drizzle(pool, { schema })
  return { db, pool, close: () => pool.end() }
}

export const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../drizzle')

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
}

export { schema }

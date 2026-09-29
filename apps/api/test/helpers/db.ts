import { sql } from 'drizzle-orm'
import { inject } from 'vitest'
import { createDatabase, runMigrations, type Database } from '../../src/db/client'

let migrated = false

/** A migrated database with every table truncated — call in beforeEach for isolation. */
export async function freshDatabase(): Promise<Database> {
  const database = createDatabase(inject('databaseUrl'), 8)
  if (!migrated) {
    await runMigrations(database.db)
    migrated = true
  }
  await database.db.execute(sql`
    DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;`)
  return database
}

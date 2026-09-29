/**
 * Local Postgres without Docker: runs a real PostgreSQL server from the `embedded-postgres` npm package.
 *   pnpm db:start            → postgres://scratchy:scratchy@127.0.0.1:5433/scratchy  (data in .data/pg)
 * Leave it running in its own terminal; Ctrl-C stops it cleanly. Anyone with Docker can use
 * `docker compose up -d db` instead (same URL).
 */
import EmbeddedPostgres from 'embedded-postgres'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const dataDir = resolve(import.meta.dirname, '../../../.data/pg')
const port = Number(process.env.PG_PORT ?? 5433)
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'scratchy',
  password: 'scratchy',
  port,
  persistent: true,
  onLog: () => {},
})

const fresh = !existsSync(resolve(dataDir, 'PG_VERSION'))
if (fresh) await pg.initialise()
await pg.start()
for (const db of ['scratchy', 'scratchy_test']) {
  try {
    await pg.createDatabase(db)
  } catch {
    /* already exists */
  }
}
console.log(`postgres ready → postgres://scratchy:scratchy@127.0.0.1:${port}/scratchy  (data: ${dataDir})`)

const stop = async () => {
  await pg.stop()
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

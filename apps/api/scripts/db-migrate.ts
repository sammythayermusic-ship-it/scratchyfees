import { createDatabase, runMigrations } from '../src/db/client'

const url = process.env.DATABASE_URL ?? 'postgres://scratchy:scratchy@127.0.0.1:5433/scratchy'
const database = createDatabase(url, 1)
await runMigrations(database.db)
await database.close()
console.log('migrations applied →', url.replace(/:[^:@/]+@/, ':***@'))

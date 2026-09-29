/**
 * Test database: CI provides TEST_DATABASE_URL (a Postgres service); locally we start a throwaway real
 * Postgres from the `embedded-postgres` npm package, so concurrency/locking tests run on real Postgres.
 */
import EmbeddedPostgres from 'embedded-postgres'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => res(port))
    })
    s.on('error', rej)
  })
}

export default async function setup(project: TestProject) {
  if (process.env.TEST_DATABASE_URL) {
    project.provide('databaseUrl', process.env.TEST_DATABASE_URL)
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'scratchy-pg-'))
  const port = await freePort()
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'scratchy',
    password: 'scratchy',
    port,
    persistent: false,
    onLog: () => {},
  })
  await pg.initialise()
  await pg.start()
  await pg.createDatabase('scratchy_test')
  project.provide('databaseUrl', `postgres://scratchy:scratchy@127.0.0.1:${port}/scratchy_test`)
  return async () => {
    await pg.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
  }
}

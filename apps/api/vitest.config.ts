import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/helpers/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // DB-backed suites share one database; run files sequentially to keep TRUNCATE isolation simple.
    fileParallelism: false,
  },
})

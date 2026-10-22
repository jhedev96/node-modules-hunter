import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000, // Android host is slow under parallel spawn load — heavy e2e flake-guard
    hookTimeout: 30_000,
  },
})

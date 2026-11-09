import { defineConfig } from 'vitest/config';

// Integration tests: a throwaway Postgres per run (Testcontainers), migrations applied.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.int-spec.ts'],
    globalSetup: ['./test/postgres.global-setup.ts'],
    hookTimeout: 120_000,
  },
});

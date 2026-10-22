import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': new URL('./tests/helpers/cloudflare-workers-stub.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Every suite boots a Miniflare D1 and applies the full migration
    // chain; with all files in parallel that contends hard enough to blow
    // the 10s default hook/test budgets on a loaded box (observed as mass
    // 'skipped' suites, not real failures). One honest budget, assertions unchanged.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each file boots its own Miniflare/workerd; the default fork count
    // (one per CPU) exhausts workerd under full-suite parallelism and
    // surfaces as ECONNRESET in unrelated suites. Four concurrent
    // Miniflares is stable on a 16-thread box and still parallel.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['web/src/**/*.ts'],
    },
  },
});

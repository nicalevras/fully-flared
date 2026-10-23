import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestDb, seedProduct } from './helpers/d1';
import { getStorefrontLayout } from '../web/src/server/catalog-read';
import { readListingPage } from '../web/src/server/catalog-read';
import { ALL_LISTING, LAYOUT_REF_KEY } from '../web/src/server/catalog-models';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const valid = {
  name: 'review-store',
  compatibility_date: '2026-10-17',
  workers_dev: true,
  vars: {
    BETTER_AUTH_URL: 'https://review.account.workers.dev',
    OWNER_EMAIL: 'owner@example.test',
    QUEUE_NAMES: { JOBS: 'jobs', NOTIFICATIONS: 'mail', CATALOG_JOBS: 'catalog', DLQ: 'dead' },
  },
  queues: {
    producers: [
      { binding: 'JOBS', queue: 'jobs' },
      { binding: 'NOTIFICATIONS', queue: 'mail' },
      { binding: 'CATALOG_JOBS', queue: 'catalog' },
    ],
    consumers: [
      { queue: 'catalog', max_concurrency: 1, dead_letter_queue: 'dead' },
      { queue: 'dead' },
    ],
  },
};
it('accepts workers.dev JSONC without a custom route and isolates named environment bindings', () => {
  const folder = mkdtempSync(join(tmpdir(), 'store-round3-config-'));
  const file = join(folder, 'wrangler.jsonc');
  const run = (config: unknown, env?: string) => {
    writeFileSync(file, '// JSONC configuration\n' + JSON.stringify(config).replace(/}$/, ',}'));
    return spawnSync(
      process.execPath,
      [
        resolve('web/scripts/validate-deploy.mjs'),
        '--config',
        file,
        ...(env ? ['--env', env] : []),
      ],
      { encoding: 'utf8' }
    );
  };
  try {
    expect(run(valid).status).toBe(0);
    const named = {
      ...valid,
      vars: {},
      kv_namespaces: [{ id: 'REPLACE_WITH_ROOT' }],
      env: { preview: valid },
    };
    expect(run(named, 'preview').status).toBe(0);
    expect(run(named, 'missing').status).not.toBe(0);
    expect(
      run({ ...valid, env: { preview: { queues: valid.queues } } }, 'preview').stderr
    ).toContain('BETTER_AUTH_URL');
    expect(readFileSync('web/scripts/validate-deploy.mjs', 'utf8')).not.toContain(
      'unstable_readConfig'
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

it('cold and warm anonymous storefront reads make zero D1 calls', async () => {
  const { db, dispose } = await createTestDb();
  const values = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  } as unknown as KVNamespace;
  try {
    await seedProduct(db);
    await buildCatalogReadModels(db, kv);
    // A new binding object simulates an isolate cold start without warming a pointer memo.
    const coldKv = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
    } as unknown as KVNamespace;
    const prepare = vi.fn(() => {
      throw new Error('Anonymous page queried D1');
    });
    const forbiddenDb = { prepare } as unknown as D1Database;
    // Since Phase 4 the HTML itself is cached by Workers Cache in
    // front of PublicStorefront; what this suite still guarantees is
    // the read path underneath it: anonymous listing/layout reads are
    // served from KV with zero D1 calls, cold or warm.
    const render = () =>
      runWithRequestContext({} as ExecutionContext, async () => {
        const [page, layout] = await Promise.all([
          readListingPage(forbiddenDb, coldKv, ALL_LISTING, 1),
          getStorefrontLayout(forbiddenDb, { CATALOG_KV: coldKv }),
        ]);
        return { title: page?.cards[0]?.title, storeName: layout.storeName };
      });
    vi.useFakeTimers();
    const first = await render();
    expect(first.title).toBe('Tee');
    expect(await render()).toEqual(first);
    await vi.advanceTimersByTimeAsync(5001);
    await Promise.all(Array.from({ length: 8 }, () => render()));
    expect(prepare).not.toHaveBeenCalled();
    expect(vi.mocked(coldKv.get).mock.calls.filter(([key]) => key === LAYOUT_REF_KEY)).toHaveLength(
      10
    );
    process.stdout.write(
      'PASS cold/warm/concurrent anonymous storefront reads: D1 calls=0; layout ref reads=10 (one per independent request, no stale cross-request memo)\n'
    );
  } finally {
    vi.useRealTimers();
    await dispose();
  }
});

it('records corrupt catalog values and recovers from D1 without raw errors or PII', async () => {
  const { db, dispose } = await createTestDb();
  const values = new Map<string, string>();
  const privateText = 'private@example.test secret-token';
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const kv = {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  } as unknown as KVNamespace;
  try {
    await seedProduct(db);
    await buildCatalogReadModels(db, kv);
    // Corrupt every published catalog value with private-looking text.
    for (const key of [...values.keys()])
      if (key.startsWith('catalog:r1:')) values.set(key, privateText);
    const page = await readListingPage(db, kv, ALL_LISTING, 1);
    expect(page?.cards).toHaveLength(1);
    const events = warn.mock.calls.map(([value]) => JSON.parse(String(value)).event);
    expect(events).toContain('catalog_model_kv_read_failed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateText);
  } finally {
    await dispose();
  }
});
import { buildCatalogReadModels } from './helpers/catalog-driver';
import { runWithRequestContext } from '../web/src/server/exec-context';

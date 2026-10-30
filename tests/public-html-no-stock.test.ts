import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env as workerEnv } from './helpers/cloudflare-workers-stub';
import { buildCatalogReadModels } from './helpers/catalog-driver';
import { createTestDb, seedProduct } from './helpers/d1';
import { createMemoryHistory } from '../web/node_modules/@tanstack/react-router';
import { getRouter } from '../web/src/router';

// Without Start's compiler, createIsomorphicFn runs its `.server()` implementation,
// so the router below loads the page exactly the way SSR does before dehydrating it.
vi.mock('../web/node_modules/@tanstack/react-start', async (original) => {
  const chain = { middleware: () => chain, validator: () => chain, handler: (run: unknown) => run };
  return {
    ...(await original<typeof import('../web/node_modules/@tanstack/react-start')>()),
    createServerFn: () => chain,
  };
});
vi.mock('../web/node_modules/@tanstack/react-start/dist/esm/server.js', () => ({
  getRequest: () => new Request('https://shop.test/products/tee'),
  setResponseHeader: () => {},
  setResponseStatus: () => {},
}));

class Kv {
  map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

let dispose: () => Promise<void>;
beforeEach(async () => {
  const test = await createTestDb();
  dispose = test.dispose;
  const kv = new Kv();
  await seedProduct(test.db, { onHand: 17 });
  await buildCatalogReadModels(test.db, kv);
  workerEnv.DB = test.db;
  workerEnv.CATALOG_KV = kv;
});
afterEach(async () => {
  delete workerEnv.DB;
  delete workerEnv.CATALOG_KV;
  await dispose();
});

it('cacheable PDP HTML contains no availability state', async () => {
  const router = getRouter();
  router.update({
    ...router.options,
    isServer: true,
    history: createMemoryHistory({ initialEntries: ['/products/tee'] }),
  });
  await router.load();
  const pdp = router.state.matches.find((match) => match.routeId === '/_shop/products/$slug');
  expect(pdp?.status).toBe('success');
  const dehydrated = JSON.stringify(
    router.state.matches.map((match) => [match.loaderData, match.meta, match.headScripts])
  );
  expect(dehydrated).toContain('"slug":"tee"');
  expect(dehydrated).not.toMatch(/"available"|in_stock|sold_out|backorder|InStock|OutOfStock/);
});

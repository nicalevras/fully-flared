import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env as workerEnv } from './helpers/cloudflare-workers-stub';
import { createTestDb, seedProduct } from './helpers/d1';
import { addCartLineFn, setCartLineFn } from '../web/src/lib/cartFns';

const network = vi.hoisted(() => ({ ip: '203.0.113.7', status: 200 }));
vi.mock('../web/node_modules/@tanstack/react-start', async (original) => {
  const chain = { middleware: () => chain, validator: () => chain, handler: (run: unknown) => run };
  return {
    ...(await original<typeof import('../web/node_modules/@tanstack/react-start')>()),
    createServerFn: () => chain,
  };
});
vi.mock('../web/node_modules/@tanstack/react-start/dist/esm/server.js', () => ({
  getRequest: () =>
    new Request('https://shop.test/_serverFn', { headers: { 'CF-Connecting-IP': network.ip } }),
  setResponseHeader: () => {},
  appendResponseHeader: () => {},
  setResponseStatus: (status: number) => {
    network.status = status;
  },
}));

function fakeLimiter(limit: number) {
  const counts = new Map<string, number>();
  return {
    limit: async ({ key }: { key: string }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 100 });
  workerEnv.DB = db;
  workerEnv.STOREFRONT_LIMITER = fakeLimiter(30);
  network.ip = '203.0.113.7';
  network.status = 200;
});
afterEach(async () => {
  delete workerEnv.DB;
  delete workerEnv.STOREFRONT_LIMITER;
  await dispose();
});

const carts = async () =>
  (await db.prepare('SELECT count(*) AS n FROM carts').first<{ n: number }>())?.n;

it('31st cookieless add in a minute is limited', async () => {
  for (let i = 0; i < 30; i++) await addCartLineFn({ data: { sku: 'TEE-1', qty: 1 } });
  expect(await carts()).toBe(30);

  await expect(addCartLineFn({ data: { sku: 'TEE-1', qty: 1 } })).rejects.toThrow();
  await expect(setCartLineFn({ data: { sku: 'TEE-1', qty: 2 } })).rejects.toThrow();
  expect(network.status).toBe(429);
  expect(await carts()).toBe(30);

  network.ip = '198.51.100.9';
  await addCartLineFn({ data: { sku: 'TEE-1', qty: 1 } });
  expect(await carts()).toBe(31);
});

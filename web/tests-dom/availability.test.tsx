// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env as workerEnv } from '../../tests/helpers/cloudflare-workers-stub';
import { buildCatalogReadModels } from '../../tests/helpers/catalog-driver';
import { createTestDb, seedProduct } from '../../tests/helpers/d1';
import { getRouter } from '@/router';

const serverCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../node_modules/@tanstack/react-start', async (original) => {
  const chain = {
    middleware: () => chain,
    validator: () => chain,
    handler:
      <I, O>(run: (input: I) => O) =>
      (input: I) => {
        serverCalls.count++;
        return run(input);
      },
  };
  // The client bundle Start compiles keeps only the `.client()` implementation.
  const clientBundle = () => {
    const fn = { server: () => fn, client: <T,>(impl: T) => impl };
    return fn;
  };
  return {
    ...(await original<typeof import('../node_modules/@tanstack/react-start')>()),
    createServerFn: () => chain,
    createIsomorphicFn: clientBundle,
  };
});
vi.mock('../node_modules/@tanstack/react-start/dist/esm/server.js', () => ({
  getRequest: () => new Request('https://shop.test/_serverFn/page'),
  setResponseHeader: () => {},
  appendResponseHeader: () => {},
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
  await seedProduct(test.db, { onHand: 20 });
  await buildCatalogReadModels(test.db, kv);
  workerEnv.DB = test.db;
  workerEnv.CATALOG_KV = kv;
}, 30_000);
afterEach(async () => {
  cleanup();
  delete workerEnv.DB;
  delete workerEnv.CATALOG_KV;
  await dispose();
});

it('PDP SPA navigation makes one server call', async () => {
  const router = getRouter();
  router.update({ ...router.options, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  render(<RouterProvider router={router} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  serverCalls.count = 0;

  await act(async () => {
    await router.navigate({ to: '/products/$slug', params: { slug: 'tee' } });
  });
  expect((await screen.findByRole('status')).textContent).toContain('In stock');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(serverCalls.count).toBe(1);
}, 30_000);

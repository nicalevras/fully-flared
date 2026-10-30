// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const stockReads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/server/availability', async (original) => {
  const actual = await original<typeof import('../src/server/availability')>();
  return {
    ...actual,
    getAvailability: (...args: Parameters<typeof actual.getAvailability>) => {
      stockReads.count++;
      return actual.getAvailability(...args);
    },
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

it('a hover preload reads no stock; the click reads it once in one server call', async () => {
  const router = getRouter();
  router.update({ ...router.options, history: createMemoryHistory({ initialEntries: ['/shop'] }) });
  await router.load();
  const { container } = render(<RouterProvider router={router} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const link = container.querySelector('a[href="/products/tee"]');
  if (!link) throw new Error('no product link on /shop');
  serverCalls.count = 0;
  stockReads.count = 0;

  fireEvent.mouseEnter(link);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(serverCalls.count).toBe(1);
  expect(stockReads.count).toBe(0);

  serverCalls.count = 0;
  fireEvent.click(link);
  expect((await screen.findByRole('status')).textContent).toContain('In stock');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(router.state.location.pathname).toBe('/products/tee');
  expect(serverCalls.count).toBe(1);
  expect(stockReads.count).toBe(1);
}, 30_000);

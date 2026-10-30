import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { buildCatalogReadModels } from './helpers/catalog-driver';
import { readProductDocument } from '../web/src/server/catalog-read';
import { suggestCatalog } from '../web/src/server/catalog-discovery';
import { storefrontLimited } from '../web/src/server/storefront-limit';
import { published } from './helpers/fixtures';

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

const from = (ip: string) =>
  new Request('https://shop.test/', { headers: { 'CF-Connecting-IP': ip } });

let db: D1Database, dispose: () => Promise<void>, kv: Kv, queries: number, noD1: D1Database;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  kv = new Kv();
  await seedProduct(db);
  await buildCatalogReadModels(db, kv);
  queries = 0;
  noD1 = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return () => {
          queries++;
          throw new Error('Unexpected D1 query');
        };
      return Reflect.get(target, key);
    },
  });
});
afterEach(() => dispose());

it('budgets each kind per IPv6 /64 or IPv4 address', async () => {
  const limiter = fakeLimiter(30);
  for (let i = 0; i < 30; i++)
    expect(await storefrontLimited(limiter, 'product', from(`2001:db8:1:2::${i}`))).toBe(false);
  expect(await storefrontLimited(limiter, 'product', from('2001:db8:1:2::ff'))).toBe(true);
  expect(await storefrontLimited(limiter, 'search', from('2001:db8:1:2::ff'))).toBe(false);
  expect(await storefrontLimited(limiter, 'product', from('2001:db8:1:3::1'))).toBe(false);
  expect(await storefrontLimited(limiter, 'product', from('203.0.113.7'))).toBe(false);
});

it('fails open when the binding is absent or failing', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const broken = { limit: () => Promise.reject(new Error('limiter down')) };
  expect(await storefrontLimited(undefined, 'product', from('203.0.113.7'))).toBe(false);
  expect(await storefrontLimited(broken, 'search', from('203.0.113.7'))).toBe(false);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('storefront_limiter_unavailable'));
  error.mockRestore();
});

it('a published product is served from KV without spending the budget', async () => {
  const limited = vi.fn(async () => {});
  expect(published(await readProductDocument(noD1, kv, 'tee', limited)).slug).toBe('tee');
  expect(limited).not.toHaveBeenCalled();
  expect(queries).toBe(0);
});

it('an unknown slug is refused before D1 once the budget is spent', async () => {
  const refuse = async () => {
    throw new Error('limited');
  };
  await expect(readProductDocument(noD1, kv, 'no-such-product', refuse)).rejects.toThrow('limited');
  expect(queries).toBe(0);
  expect(await readProductDocument(db, kv, 'no-such-product', async () => {})).toBeNull();
});

it('only searches with terms spend the budget, and a refused search reads no D1', async () => {
  const limited = vi.fn(async () => true);
  expect(await suggestCatalog(noD1, {}, '   ', limited)).toEqual({
    cards: [],
    hasMore: false,
  });
  expect(limited).not.toHaveBeenCalled();
  expect(await suggestCatalog(noD1, {}, 'tee', limited)).toEqual({
    cards: [],
    hasMore: false,
    limited: true,
  });
  expect(queries).toBe(0);
  const allowed = await suggestCatalog(db, {}, 'tee', async () => false);
  expect(allowed.cards.map((card) => card.slug)).toEqual(['tee']);
});

import { beforeEach, afterEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { readListingPage, readProductDocument } from '../web/src/server/catalog-read';
import { getShopProductsPage, listAllCollections } from '../web/src/server/catalog-read';
import { getPublishedCollection } from '../web/src/server/catalog-discovery';
import { ALL_LISTING } from '../web/src/server/catalog-models';
import { runWithRequestContext } from '../web/src/server/exec-context';

class FakeKv {
  map = new Map<string, string>();
  puts = 0;
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.puts++;
    this.map.set(key, value);
  }
}

let db: D1Database, dispose: () => Promise<void>;
let kv: FakeKv;

async function product(id: string, slug: string, title: string, createdAt: string) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO products(id,slug,title,description,status,created_at,updated_at) VALUES(?,?,?,'desc','active',?,?)"
      )
      .bind(id, slug, title, createdAt, createdAt),
    db
      .prepare(
        "INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) VALUES(?,?,?,?,1000,'active',?)"
      )
      .bind(`v-${id}`, id, `SKU-${id}`, 'Default', createdAt),
    db
      .prepare('INSERT INTO stock(sku,on_hand,reserved,updated_at) VALUES(?,50,0,?)')
      .bind(`SKU-${id}`, createdAt),
  ]);
}

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  kv = new FakeKv();
  for (let i = 1; i <= 30; i++)
    await product(
      `p${i}`,
      `prod-${i}`,
      `Prod ${i}`,
      `2026-01-${String(31 - Math.floor(i / 2)).padStart(2, '0')}T00:00:00.000Z`
    );
  await db
    .prepare(
      "INSERT INTO collections(id,slug,title,description,kind,created_at) VALUES('c1','manual-one','Manual One','Desc','manual','2026-01-01')"
    )
    .run();
  for (let i = 1; i <= 30; i++)
    await db
      .prepare('INSERT INTO product_collections(product_id,collection_id) VALUES(?,?)')
      .bind(`p${i}`, 'c1')
      .run();
  await buildCatalogReadModels(db, kv);
});
afterEach(async () => {
  await dispose();
});

it('a response pins one publication for count and page', async () => {
  let refReads = 0;
  const flipping = {
    map: kv.map,
    async get(key: string) {
      if (key.endsWith(':listing:all:current')) {
        refReads++;
        if (refReads > 1)
          return JSON.stringify({
            listingId: 'all',
            generation: 99,
            publicationSeq: 99,
            pageSize: 24,
            total: 999,
            pageCount: 99,
            rootHash: 'tampered',
          });
      }
      return kv.map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      kv.map.set(key, value);
    },
  };
  const result = await getShopProductsPage(db, { CATALOG_KV: flipping as never, DB: db }, 2);
  expect(result.total).toBe(30);
  expect(result.pageCount).toBe(2);
  expect(result.products).toHaveLength(6);
});

it('single-product fallback reads its published document, never live source', async () => {
  kv.map.clear();
  let statements = 0;
  let unboundedScans = 0;
  const counting = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          statements++;
          if (/FROM products WHERE status = 'active'\s*$/i.test(sql.trim())) unboundedScans++;
          return (target as D1Database).prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const doc = await readProductDocument(counting as never, kv, 'prod-7');
  expect(doc?.slug).toBe('prod-7');
  expect(unboundedScans).toBe(0);
  expect(statements).toBeLessThanOrEqual(8);
});

it('collection metadata serves from its published document', async () => {
  expect([...kv.map.keys()].some((k) => k.endsWith(':collection:manual-one:meta'))).toBe(true);
  // Remove the D1 row: the published metadata document still serves.
  await db.prepare("DELETE FROM product_collections WHERE collection_id='c1'").run();
  await db.prepare("DELETE FROM collections WHERE id='c1'").run();
  const result = await getPublishedCollection(db, { CATALOG_KV: kv as never }, 'manual-one', 1);
  expect(result?.collection.title).toBe('Manual One');
  expect(result?.total).toBe(30);
});

it('collections index paginates with an accurate total', async () => {
  for (let i = 2; i <= 50; i++)
    await db
      .prepare(
        "INSERT INTO collections(id,slug,title,description,kind,created_at) VALUES(?, ?, ?, '', 'manual', '2026-01-01')"
      )
      .bind(`cx${i}`, `col-${String(i).padStart(2, '0')}`, `Col ${i}`)
      .run();
  await buildCatalogReadModels(db, kv);
  const env = { CATALOG_KV: kv as never };
  const page1 = await listAllCollections(db, env, 1);
  expect(page1.total).toBe(50);
  expect(page1.pageCount).toBe(2);
  expect(page1.collections).toHaveLength(48);
  const page2 = await listAllCollections(db, env, 2);
  expect(page2.collections).toHaveLength(2);
  const clamped = await listAllCollections(db, env, 99);
  expect(clamped.page).toBe(2);
  const seen = new Set([...page1.collections, ...page2.collections].map((c) => c.slug));
  expect(seen.size).toBe(50);
});

it('concurrent identical reference reads share one in-flight KV get', async () => {
  let refGets = 0;
  const counting = {
    map: kv.map,
    async get(key: string) {
      if (key.endsWith(':listing:all:current')) refGets++;
      await new Promise((r) => setTimeout(r, 5));
      return kv.map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      kv.map.set(key, value);
    },
  };
  const pages = await runWithRequestContext({} as ExecutionContext, () =>
    Promise.all([
      readListingPage(db, counting as never, ALL_LISTING, 1),
      readListingPage(db, counting as never, ALL_LISTING, 1),
      readListingPage(db, counting as never, ALL_LISTING, 2),
    ])
  );
  expect(pages[0]?.total).toBe(30);
  expect(pages[2]?.cards).toHaveLength(6);
  expect(refGets).toBe(1);
});
import { buildCatalogReadModels } from './helpers/catalog-driver';

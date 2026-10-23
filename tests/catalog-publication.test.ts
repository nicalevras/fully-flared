import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { processCatalogWork } from '../web/src/server/catalog-publisher';
import {
  getShopProductsPage,
  readListingPage,
  readListingRef,
} from '../web/src/server/catalog-read';
import { getPublishedCollection } from '../web/src/server/catalog-discovery';
import {
  ALL_LISTING,
  collectionMetaKey,
  listingPageKey,
  listingRefKey,
} from '../web/src/server/catalog-models';
import { drainCatalogInvalidations } from '../web/src/server/public-cache';

// Publication guarantees for the partitioned catalog (Phase 3B). This
// file previously covered the whole-catalog snapshot publisher; the
// protections that still matter are asserted here against the
// work-driven partitioned publisher that replaced it.

let db: D1Database, dispose: () => Promise<void>;
const map = new Map<string, string>();
let failPuts = false;
const writes: string[] = [];
const kv = {
  async get(key: string) {
    return map.get(key) ?? null;
  },
  async put(key: string, value: string) {
    if (failPuts) throw new Error('KV unavailable');
    writes.push(key);
    map.set(key, value);
  },
  async delete(key: string) {
    map.delete(key);
  },
};
const env = { CATALOG_KV: kv as never, DB: undefined as never };

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  await seedProduct(db);
  await buildCatalogReadModels(db, kv);
  await processCatalogWork(db, kv);
});
afterAll(async () => {
  await dispose();
});

async function workState() {
  return db
    .prepare('SELECT COUNT(*) AS due FROM catalog_work WHERE processed_revision < target_revision')
    .first<{ due: number }>();
}

it('coalesces completed work and preserves edits made while publishing', async () => {
  await db.prepare("UPDATE products SET title='Edited after build' WHERE id='p1'").run();
  const result = await processCatalogWork(db, kv);
  expect(result.processed).toBeGreaterThan(0);
  const page = await readListingPage(db, kv, ALL_LISTING, 1);
  expect(page?.cards.some((c) => c.title === 'Edited after build')).toBe(true);
  const before = writes.length;
  const again = await processCatalogWork(db, kv);
  expect(again.processed).toBe(0);
  expect(writes).toHaveLength(before);
  expect((await workState())?.due).toBe(0);
});

it('recovers from missing and malformed KV payloads using D1 payloads', async () => {
  const viaKv = await readListingPage(db, kv, ALL_LISTING, 1);
  map.clear();
  const missing = await readListingPage(db, kv, ALL_LISTING, 1);
  expect(missing?.cards.map((c) => c.id)).toEqual(viaKv?.cards.map((c) => c.id));
  await buildCatalogReadModels(db, kv);
  for (const key of [...map.keys()]) map.set(key, '{broken');
  const malformed = await readListingPage(db, kv, ALL_LISTING, 1);
  expect(malformed?.cards.length).toBeGreaterThan(0);
});

it('a failed publication cannot hide a later edit; the next pass publishes it', async () => {
  await db.prepare("UPDATE products SET title='Recovered edit' WHERE id='p1'").run();
  failPuts = true;
  await expect(processCatalogWork(db, kv)).rejects.toThrow('KV unavailable');
  failPuts = false;
  expect((await workState())?.due).toBeGreaterThan(0);
  const retry = await db
    .prepare("SELECT retry_count FROM catalog_work WHERE entity_type='product' AND entity_id='p1'")
    .first<{ retry_count: number }>();
  expect(retry?.retry_count).toBeGreaterThan(0);
  await db
    .prepare(
      "UPDATE catalog_work SET next_attempt_at='2000-01-01' WHERE processed_revision < target_revision"
    )
    .run();
  await processCatalogWork(db, kv);
  const page = await readListingPage(db, kv, ALL_LISTING, 1);
  expect(page?.cards.some((c) => c.title === 'Recovered edit')).toBe(true);
  expect((await workState())?.due).toBe(0);
});

it('finds old products beyond a 500-card degraded home page', async () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({
    id: `hp${i}`,
    slug: `home-${i}`,
    created: new Date(Date.UTC(2025, 0, 1) + i * 1000).toISOString(),
  }));
  for (let s = 0; s < rows.length; s += 1000) {
    const chunk = rows.slice(s, s + 1000);
    await db.batch([
      db
        .prepare(
          `INSERT INTO products(id,slug,title,description,status,created_at,updated_at)
           SELECT json_extract(value,'$.id'), json_extract(value,'$.slug'), json_extract(value,'$.slug'), '', 'active', json_extract(value,'$.created'), json_extract(value,'$.created') FROM json_each(?)`
        )
        .bind(JSON.stringify(chunk)),
      db
        .prepare(
          `INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at)
           SELECT 'v' || json_extract(value,'$.id'), json_extract(value,'$.id'), 'SKU-' || json_extract(value,'$.id'), 'D', 100, 'active', json_extract(value,'$.created') FROM json_each(?)`
        )
        .bind(JSON.stringify(chunk)),
      db
        .prepare(
          `INSERT INTO stock(sku,on_hand,reserved,updated_at)
           SELECT 'SKU-' || json_extract(value,'$.id'), 10, 0, json_extract(value,'$.created') FROM json_each(?)`
        )
        .bind(JSON.stringify(chunk)),
    ]);
  }
  await buildCatalogReadModels(db, kv);
  const home = await getShopProductsPage(db, env as never, 26);
  expect(home.total).toBe(601);
  expect(home.pageCount).toBe(26);
  expect(home.products.length).toBeGreaterThan(0);
});

it('/shop page N reads only page N of the catalogue', async () => {
  const read: string[] = [];
  const recording = {
    ...kv,
    async get(key: string) {
      read.push(key);
      return kv.get(key);
    },
  };
  const shop = await getShopProductsPage(db, { CATALOG_KV: recording } as never, 2);
  expect(shop.page).toBe(2);
  expect(read.some((key) => key.startsWith(listingPageKey(ALL_LISTING, 2, '')))).toBe(true);
  expect(read.some((key) => key.startsWith(listingPageKey(ALL_LISTING, 1, '')))).toBe(false);
});

it('paginates collections at 48 per page with a total', async () => {
  await db
    .prepare(
      "INSERT INTO collections(id,slug,title,kind,created_at) VALUES('big','big','Big','manual','2026-01-01')"
    )
    .run();
  const ids = (
    await db.prepare("SELECT id FROM products WHERE status='active' LIMIT 50").all<{ id: string }>()
  ).results;
  for (const r of ids)
    await db
      .prepare('INSERT OR IGNORE INTO product_collections(product_id,collection_id) VALUES(?,?)')
      .bind(r.id, 'big')
      .run();
  await processCatalogWork(db, kv);
  const page2 = await getPublishedCollection(db, env as never, 'big', 2);
  expect(page2?.total).toBe(50);
  expect(page2?.pageCount).toBe(2);
  expect(page2?.products).toHaveLength(2);
});

it('a title rule with LIKE wildcards matches literally', async () => {
  // Bounded passes claim due rows in order; acknowledge the seed
  // backlog first so the next pass claims the new rows (same
  // pattern as the scale gate).
  await db.prepare('UPDATE catalog_work SET processed_revision = target_revision').run();
  await db.batch([
    db.prepare(
      "INSERT INTO products(id,slug,title,description,status,created_at,updated_at) VALUES('w1','w1','50% deal','','active','2026-02-01','2026-02-01')"
    ),
    db.prepare(
      "INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) VALUES('vw1','w1','SKU-w1','D',100,'active','2026-02-01')"
    ),
    db.prepare(
      "INSERT INTO products(id,slug,title,description,status,created_at,updated_at) VALUES('w2','w2','500 deal','','active','2026-02-02','2026-02-02')"
    ),
    db.prepare(
      "INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) VALUES('vw2','w2','SKU-w2','D',100,'active','2026-02-02')"
    ),
    db.prepare(
      `INSERT INTO collections(id,slug,title,kind,rule_json,created_at) VALUES('wr','wr','WR','rule','{"type":"title_contains","value":"50%"}','2026-01-01')`
    ),
  ]);
  await processCatalogWork(db, kv);
  const col = await getPublishedCollection(db, env as never, 'wr', 1);
  expect(col?.products.map((p) => p.id)).toEqual(['w1']);
});

it('no single KV value holds the whole catalog; references stay small', async () => {
  let max = 0;
  for (const [key, value] of map) {
    if (key === listingRefKey(ALL_LISTING)) expect(value.length).toBeLessThan(16 * 1024);
    max = Math.max(max, value.length);
  }
  expect(max).toBeLessThan(128 * 1024);
  const ref = JSON.parse(map.get(listingRefKey(ALL_LISTING))!) as { total: number };
  expect(ref.total).toBe(603);
});
import { buildCatalogReadModels } from './helpers/catalog-driver';

it('a deleted collection is retired: its pages disappear and its cache is purged once', async () => {
  await db
    .prepare(
      "INSERT INTO collections(id,slug,title,kind,created_at) VALUES('gone','gone','Gone','manual','2026-01-01')"
    )
    .run();
  await db
    .prepare("INSERT INTO product_collections(product_id,collection_id) VALUES('p1','gone')")
    .run();
  await processCatalogWork(db, kv);
  expect(await getPublishedCollection(db, env as never, 'gone', 1)).not.toBeNull();
  const stalePointer = map.get(collectionMetaKey('gone')) ?? '';
  expect(stalePointer).not.toBe('');

  await db.prepare("DELETE FROM product_collections WHERE collection_id='gone'").run();
  await db.prepare("DELETE FROM collections WHERE id='gone'").run();
  await db.prepare('DELETE FROM catalog_invalidations').run();
  await processCatalogWork(db, kv);
  expect(await getPublishedCollection(db, env as never, 'gone', 1)).toBeNull();
  expect(map.has(listingRefKey('gone'))).toBe(false);
  expect(await readListingRef(db, kv, 'gone')).toBeNull();
  map.set(collectionMetaKey('gone'), stalePointer);
  expect(await readListingRef(db, kv, 'gone')).toBeNull();
  expect(await getPublishedCollection(db, env as never, 'gone', 1)).toBeNull();
  map.delete(collectionMetaKey('gone'));
  const purged: string[] = [];
  await drainCatalogInvalidations(db, async (tags) => purged.push(...tags));
  expect(purged).toContain('listing-gone');

  const before = writes.length;
  expect((await processCatalogWork(db, kv)).processed).toBe(0);
  expect(writes).toHaveLength(before);
  expect(await getPublishedCollection(db, env as never, 'gone', 1)).toBeNull();
});

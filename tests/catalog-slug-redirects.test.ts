import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { buildCatalogReadModels } from './helpers/catalog-driver';
import {
  processCatalogWork,
  requestCatalogSourceRebuild,
} from '../web/src/server/catalog-publisher';
import { productSlugKey } from '../web/src/server/catalog-models';
import { loadPostPage, loadProductPage } from '../web/src/server/storefront-pages';

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

let db: D1Database;
let dispose: () => Promise<void>;
let kv: Kv;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  kv = new Kv();
  await seedProduct(db);
  await db
    .prepare(
      "INSERT INTO posts(id,slug,title,excerpt,content_html,status,published_at,created_at,updated_at) VALUES('post','launch','Launch','News','<p>News</p>','published','2026-01-01','2026-01-01','2026-01-01')"
    )
    .run();
  await buildCatalogReadModels(db, kv);
});
afterEach(async () => dispose());

async function publish() {
  for (let pass = 0; pass < 20; pass++) {
    const result = await processCatalogWork(db, kv);
    if (!result.more && result.processed === 0) return;
  }
  throw new Error('catalogue work did not settle');
}

/** Renames as the admin save does: the row, then its redirect. */
async function rename(table: 'products' | 'posts', id: string, from: string, to: string) {
  const prefix = table === 'products' ? '/products/' : '/blog/';
  await db.batch([
    db.prepare(`UPDATE ${table} SET slug=? WHERE id=?`).bind(to, id),
    db
      .prepare(
        'INSERT INTO redirects(id,from_path,to_path,created_at) VALUES(?,?,?,?) ON CONFLICT(from_path) DO UPDATE SET to_path=excluded.to_path'
      )
      .bind(`r-${from}`, prefix + from, prefix + to, '2026-01-02'),
  ]);
  await publish();
}

/** Runs a storefront load against a D1 that counts every query. */
async function served(load: (counted: D1Database, limit: () => Promise<void>) => Promise<unknown>) {
  let queries = 0,
    limited = 0;
  const counted = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare' || prop === 'batch') queries++;
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const outcome = await load(counted, async () => {
    limited++;
  }).then(
    (page) => ({ page }),
    (thrown: unknown) => ({ thrown })
  );
  return { outcome, queries, limited };
}

const moved = (to: string) => ({
  outcome: {
    thrown: expect.objectContaining({ options: expect.objectContaining({ to, statusCode: 301 }) }),
  },
  queries: 0,
  limited: 0,
});

it('redirects a renamed product slug from KV with a 301 and no D1 or limiter', async () => {
  await rename('products', 'p1', 'tee', 'tee-2');
  expect(
    await served((counted, limit) => loadProductPage(counted, { CATALOG_KV: kv }, 'tee', limit))
  ).toEqual(moved('/products/tee-2'));
});

it('redirects a renamed post slug from KV with a 301 and no D1', async () => {
  await rename('posts', 'post', 'launch', 'launch-2');
  expect(await served((counted) => loadPostPage(counted, { CATALOG_KV: kv }, 'launch'))).toEqual(
    moved('/blog/launch-2')
  );
});

it('points every earlier slug of a chain at the latest one', async () => {
  await rename('products', 'p1', 'tee', 'tee-2');
  await rename('products', 'p1', 'tee-2', 'tee-3');
  await rename('posts', 'post', 'launch', 'launch-2');
  await rename('posts', 'post', 'launch-2', 'launch-3');
  expect(
    await served((counted, limit) => loadProductPage(counted, { CATALOG_KV: kv }, 'tee', limit))
  ).toEqual(moved('/products/tee-3'));
  expect(await served((counted) => loadPostPage(counted, { CATALOG_KV: kv }, 'launch'))).toEqual(
    moved('/blog/launch-3')
  );
});

it('serves a product that reuses an old slug, even after the renamed one moves again', async () => {
  await rename('products', 'p1', 'tee', 'tee-2');
  await db.batch([
    db.prepare(
      "INSERT INTO products(id,slug,title,description,status,created_at,updated_at) VALUES('p2','tee','New tee','','active','2026-01-03','2026-01-03')"
    ),
    db.prepare(
      "INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) VALUES('v2','p2','TEE-2','Default',2000,'active','2026-01-03')"
    ),
    db.prepare(
      "INSERT INTO stock(sku,on_hand,reserved,updated_at) VALUES('TEE-2',5,0,'2026-01-03')"
    ),
  ]);
  await publish();
  await rename('products', 'p1', 'tee-2', 'tee-3');
  const reused = await served((counted, limit) =>
    loadProductPage(counted, { CATALOG_KV: kv }, 'tee', limit)
  );
  expect(reused.outcome).toEqual({
    page: expect.objectContaining({ doc: expect.objectContaining({ id: 'p2', slug: 'tee' }) }),
  });
});

it('answers a KV miss for a renamed slug with a 301 from D1 after the limiter', async () => {
  await rename('products', 'p1', 'tee', 'tee-2');
  await kv.delete(productSlugKey('tee'));
  const fallback = await served((counted, limit) =>
    loadProductPage(counted, { CATALOG_KV: kv }, 'tee', limit)
  );
  expect(fallback.outcome).toEqual(moved('/products/tee-2').outcome);
  expect(fallback.limited).toBe(1);
});

it('redirects a slug renamed under a full rebuild', async () => {
  await db.batch([
    db.prepare("UPDATE products SET slug='tee-2' WHERE id='p1'"),
    db.prepare(
      "INSERT INTO redirects(id,from_path,to_path,created_at) VALUES('r-tee','/products/tee','/products/tee-2','2026-01-02')"
    ),
  ]);
  await requestCatalogSourceRebuild(db);
  await buildCatalogReadModels(db, kv);
  expect(
    await served((counted, limit) => loadProductPage(counted, { CATALOG_KV: kv }, 'tee', limit))
  ).toEqual(moved('/products/tee-2'));
});

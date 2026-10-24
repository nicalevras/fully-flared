import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { buildCatalogReadModels } from './helpers/catalog-driver';
import {
  LAYOUT_REF_KEY,
  POSTS_INDEX,
  collectionMetaKey,
  editorialKey,
  listingRefKey,
  productSlugKey,
} from '../web/src/server/catalog-models';
import {
  loadCollectionPage,
  loadEditorialPage,
  loadPostPage,
  loadPostsIndex,
  loadProductPage,
} from '../web/src/server/storefront-pages';

class GatedKv {
  map = new Map<string, string>();
  requested: string[] = [];
  private release: () => void = () => {};
  private gate: Promise<void> = Promise.resolve();
  hold() {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  open() {
    this.release();
  }
  async get(key: string) {
    this.requested.push(key);
    if (key === LAYOUT_REF_KEY) await this.gate;
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
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => dispose());

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

it('starts every storefront content read while the layout read is still pending', async () => {
  await seedProduct(db);
  await db.batch([
    db.prepare(
      "INSERT INTO collections(id,slug,title,description,kind,created_at) VALUES('c','tees','Tees','Published collection','manual','2026-01-01')"
    ),
    db.prepare("INSERT INTO product_collections(product_id,collection_id) VALUES('p1','c')"),
    db.prepare(
      "INSERT INTO pages(id,slug,title,content_html,created_at,updated_at) VALUES('page','returns','Returns','<p>Policy</p>','2026-01-01','2026-01-01')"
    ),
    db.prepare(
      "INSERT INTO posts(id,slug,title,excerpt,content_html,status,published_at,created_at,updated_at) VALUES('post','launch','Launch','News','<p>News</p>','published','2026-01-01','2026-01-01','2026-01-01')"
    ),
  ]);
  const kv = new GatedKv();
  await buildCatalogReadModels(db, kv);
  const env = { CATALOG_KV: kv };
  const cases: Array<[string, () => Promise<unknown>]> = [
    [productSlugKey('tee'), () => loadProductPage(db, env, 'tee', async () => {})],
    [collectionMetaKey('tees'), () => loadCollectionPage(db, env, 'tees', 1)],
    [editorialKey('post', 'launch'), () => loadPostPage(db, env, 'launch')],
    [editorialKey('page', 'returns'), () => loadEditorialPage(db, env, 'returns')],
    [listingRefKey(POSTS_INDEX), () => loadPostsIndex(db, env, 1)],
  ];
  const startedEarly: Record<string, boolean> = {};
  for (const [contentKey, load] of cases) {
    kv.requested = [];
    kv.hold();
    const pending = load();
    await settle();
    startedEarly[contentKey] = kv.requested.includes(contentKey);
    kv.open();
    await expect(pending).resolves.toBeTruthy();
  }
  expect(startedEarly).toEqual(Object.fromEntries(cases.map(([key]) => [key, true])));
});

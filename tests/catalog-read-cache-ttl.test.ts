import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { buildCatalogReadModels } from './helpers/catalog-driver';
import {
  getShopProductsPage,
  getStorefrontLayout,
  listPublishedPosts,
  readEditorialDocument,
  readProductDocument,
} from '../web/src/server/catalog-read';
import { getPublishedCollection } from '../web/src/server/catalog-discovery';
import { published } from './helpers/fixtures';
import {
  ALL_LISTING,
  COLLECTION_INDEX,
  LAYOUT_REF_KEY,
  POSTS_INDEX,
  collectionMetaKey,
  editorialKey,
  listingRefKey,
  productSlugKey,
} from '../web/src/server/catalog-models';

class RecordingKv {
  map = new Map<string, string>();
  reads: Array<{ key: string; cacheTtl: number | undefined }> = [];
  async get(key: string, options?: { cacheTtl?: number }) {
    this.reads.push({ key, cacheTtl: options?.cacheTtl });
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

it('edge-caches content-addressed KV reads for a day and leaves pointers at the default', async () => {
  await seedProduct(db);
  await db.batch([
    db.prepare(
      "INSERT INTO collections(id,slug,title,description,kind,created_at) VALUES('c','tees','Tees','Published collection','manual','2026-01-01')"
    ),
    db.prepare("INSERT INTO product_collections(product_id,collection_id) VALUES('p1','c')"),
    db.prepare(
      "INSERT INTO posts(id,slug,title,excerpt,content_html,status,published_at,created_at,updated_at) VALUES('post','launch','Launch','News','<p>Published news</p>','published','2026-01-01','2026-01-01','2026-01-01')"
    ),
  ]);
  const kv = new RecordingKv();
  await buildCatalogReadModels(db, kv);
  kv.reads = [];
  const env = { CATALOG_KV: kv };
  expect((await getStorefrontLayout(db, env)).storeName).toBeTruthy();
  expect((await getShopProductsPage(db, env, 1)).total).toBe(1);
  expect(published(await readProductDocument(db, kv, 'tee')).title).toBe('Tee');
  expect((await getPublishedCollection(db, env, 'tees'))?.collection.title).toBe('Tees');
  expect((await listPublishedPosts(db, env)).posts[0]?.slug).toBe('launch');
  expect(published(await readEditorialDocument(db, kv, 'post', 'launch')).title).toBe('Launch');

  const pointers = new Set([
    LAYOUT_REF_KEY,
    listingRefKey(ALL_LISTING),
    listingRefKey('c'),
    listingRefKey(COLLECTION_INDEX),
    listingRefKey(POSTS_INDEX),
    productSlugKey('tee'),
    collectionMetaKey('tees'),
    editorialKey('post', 'launch'),
  ]);
  const pointerReads = kv.reads.filter((read) => pointers.has(read.key));
  const immutableReads = kv.reads.filter((read) => !pointers.has(read.key));
  expect(pointerReads.length).toBeGreaterThanOrEqual(5);
  expect(immutableReads.length).toBeGreaterThanOrEqual(6);
  expect(pointerReads.filter((read) => read.cacheTtl !== undefined)).toEqual([]);
  expect(immutableReads.filter((read) => read.cacheTtl !== 86_400)).toEqual([]);
});

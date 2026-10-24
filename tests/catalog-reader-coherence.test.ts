import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { buildCatalogReadModels } from './helpers/catalog-driver';
import {
  readListingPage,
  readListingRef,
  readProductDocument,
} from '../web/src/server/catalog-read';
import {
  ALL_LISTING,
  productDocKey,
  directoryKey,
  LAYOUT_REF_KEY,
  layoutKey,
  editorialKey,
} from '../web/src/server/catalog-models';
import {
  getHomeCollections,
  getShopProductsPage,
  getStorefrontLayout,
  listAllCollections,
  listPublishedPosts,
  readEditorialDocument,
} from '../web/src/server/catalog-read';
import { runWithRequestContext } from '../web/src/server/exec-context';
import { getPublishedCollection } from '../web/src/server/catalog-discovery';
import { catalogQueueHarness } from './helpers/catalog-queue';

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
let db: D1Database, dispose: () => Promise<void>, kv: Kv;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  kv = new Kv();
  await seedProduct(db);
  await buildCatalogReadModels(db, kv);
});
async function pendingRefCount() {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM catalog_ref_state WHERE pending_payload IS NOT NULL')
    .first<{ n: number }>();
  return row!.n;
}
afterEach(async () => {
  vi.useRealTimers();
  await dispose();
});

it('a missing old page resolves its pinned publication, never the newest one', async () => {
  const old = await readListingRef(db, kv, ALL_LISTING);
  const page = await readListingPage(db, kv, ALL_LISTING, 1, old);
  for (const key of kv.map.keys())
    if (key.startsWith('catalog:r1:listing:all:page:')) kv.map.delete(key);
  await db.prepare("UPDATE products SET title='Unrelated new publication' WHERE id='p1'").run();
  await buildCatalogReadModels(db, kv);
  expect(await readListingPage(db, kv, ALL_LISTING, 1, old)).toEqual(page);
});

it('a schema-shaped but corrupted immutable page falls back to its exact mirror', async () => {
  const ref = await readListingRef(db, kv, ALL_LISTING);
  const page = await readListingPage(db, kv, ALL_LISTING, 1, ref);
  const key = [...kv.map.keys()].find((k) => k.startsWith('catalog:r1:listing:all:page:1:'))!;
  kv.map.set(
    key,
    JSON.stringify({ ...page, cards: page!.cards.map((c) => ({ ...c, title: 'CORRUPT' })) })
  );
  expect(await readListingPage(db, kv, ALL_LISTING, 1, ref)).toEqual(page);
});

it('a missing product value uses its published mirror rather than current source', async () => {
  const old = await readProductDocument(db, kv, 'tee');
  kv.map.delete(productDocKey(old!.id, old!.revision));
  await db.prepare("UPDATE products SET title='Draft edit not published' WHERE id='p1'").run();
  expect(await readProductDocument(db, kv, 'tee')).toEqual(old);
});

it('a missing listing reference pins committed D1 history', async () => {
  const expected = await readListingRef(db, kv, ALL_LISTING);
  kv.map.delete('catalog:r1:listing:all:current');
  expect(await readListingRef(db, kv, ALL_LISTING)).toEqual(expected);
});

it('healthy home layout, teasers and products need no source database reads', async () => {
  const forbidden = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return () => {
          throw new Error('Unexpected public D1 read');
        };
      return Reflect.get(target, key);
    },
  });
  const env = { CATALOG_KV: kv as unknown as KVNamespace };
  await getShopProductsPage(forbidden, env, 1);
  await getStorefrontLayout(forbidden, env);
  await getHomeCollections(forbidden, env);
});

it('request promises pin sequential and concurrent reads without leaking across requests', async () => {
  let gets = 0;
  const counting = {
    async get(key: string) {
      gets++;
      return kv.get(key);
    },
  };
  await runWithRequestContext({} as ExecutionContext, async () => {
    const first = await readListingRef(db, counting, ALL_LISTING);
    const replacement = { ...first!, publicationSeq: 100 };
    kv.map.set('catalog:r1:listing:all:current', JSON.stringify(replacement));
    const [second, third] = await Promise.all([
      readListingRef(db, counting, ALL_LISTING),
      readListingRef(db, counting, ALL_LISTING),
    ]);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(gets).toBe(1);
  });
  const next = await runWithRequestContext({} as ExecutionContext, () =>
    readListingRef(db, counting, ALL_LISTING)
  );
  expect(next!.publicationSeq).toBe(100);
  expect(gets).toBe(2);
});

it('A to B to A reuse and corrupt directory/product/layout values resolve exact durable artifacts', async () => {
  const a = await readListingRef(db, kv, ALL_LISTING);
  const original = await readListingPage(db, kv, ALL_LISTING, 1, a);
  const doc = await readProductDocument(db, kv, 'tee');
  const layout = await getStorefrontLayout(db, { CATALOG_KV: kv });
  await db.prepare("UPDATE products SET title='B' WHERE id='p1'").run();
  await buildCatalogReadModels(db, kv);
  expect(await pendingRefCount()).toBe(0);
  await db.prepare("UPDATE products SET title='Tee' WHERE id='p1'").run();
  await buildCatalogReadModels(db, kv);
  expect(await pendingRefCount()).toBe(0);
  const again = await readListingRef(db, kv, ALL_LISTING);
  expect(again!.rootHash).toBe(a!.rootHash);
  for (const key of kv.map.keys()) if (key.includes(':listing:all:page:')) kv.map.delete(key);
  kv.map.set(
    directoryKey(a!.rootHash),
    JSON.stringify({ kind: 'pages', entries: [{ page: 1, revision: 'wrong-but-schema-shaped' }] })
  );
  kv.map.set(productDocKey(doc!.id, doc!.revision), JSON.stringify({ ...doc, title: 'Corrupt' }));
  const revision = JSON.parse(kv.map.get(LAYOUT_REF_KEY)!).revision;
  const raw = JSON.parse(kv.map.get(layoutKey(revision))!);
  kv.map.set(layoutKey(revision), JSON.stringify({ ...raw, storeName: 'Corrupt' }));
  expect(await readListingPage(db, kv, ALL_LISTING, 1, a)).toEqual(original);
  expect((await readListingPage(db, kv, ALL_LISTING, 1, again))!.cards).toEqual(original!.cards);
  expect(await readProductDocument(db, kv, 'tee')).toEqual(doc);
  expect(await getStorefrontLayout(db, { CATALOG_KV: kv })).toEqual(layout);
});

it('published collection, editorial, navigation and discovery render with zero D1 calls', async () => {
  await db.batch([
    db.prepare(
      "INSERT INTO collections(id,slug,title,description,kind,created_at) VALUES('c','tees','Tees','Published collection','manual','2026-01-01')"
    ),
    db.prepare("INSERT INTO product_collections(product_id,collection_id) VALUES('p1','c')"),
    db.prepare(
      "INSERT INTO pages(id,slug,title,content_html,created_at,updated_at) VALUES('page','returns','Returns','<p>Published policy</p>','2026-01-01','2026-01-01')"
    ),
    db.prepare(
      "INSERT INTO posts(id,slug,title,excerpt,content_html,status,published_at,created_at,updated_at) VALUES('post','launch','Launch','News','<p>Published news</p>','published','2026-01-01','2026-01-01','2026-01-01')"
    ),
  ]);
  await buildCatalogReadModels(db, kv);
  let calls = 0;
  const forbidden = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return () => {
          calls++;
          throw new Error('Unexpected public D1');
        };
      return Reflect.get(target, key);
    },
  });
  const env = { CATALOG_KV: kv as never };
  await runWithRequestContext({} as ExecutionContext, async () => {
    expect((await getStorefrontLayout(forbidden, env)).collections[0]!.slug).toBe('tees');
    expect((await getHomeCollections(forbidden, env))[0]!.description).toBe('Published collection');
    expect((await getShopProductsPage(forbidden, env, 1)).total).toBe(1);
    expect((await getPublishedCollection(forbidden, env, 'tees'))!.collection.title).toBe('Tees');
    expect((await listAllCollections(forbidden, env)).total).toBe(1);
    expect((await listPublishedPosts(forbidden, env)).posts[0]!.slug).toBe('launch');
    expect((await readProductDocument(forbidden, kv, 'tee'))!.title).toBe('Tee');
    expect((await readEditorialDocument(forbidden, kv, 'page', 'returns'))!.contentHtml).toBe(
      '<p>Published policy</p>'
    );
    expect((await readEditorialDocument(forbidden, kv, 'post', 'launch'))!.excerpt).toBe('News');
  });
  expect(calls).toBe(0);
  // Corrupt a schema-shaped document, then lose its pointer: both reads
  // retain the committed content even when source changes unpublished.
  const key = JSON.parse(kv.map.get(editorialKey('page', 'returns'))!).key;
  kv.map.set(
    key,
    JSON.stringify({
      ...(await readEditorialDocument(db, kv, 'page', 'returns'))!,
      title: 'Corrupt',
    })
  );
  await db.prepare("UPDATE pages SET title='Unpublished edit' WHERE id='page'").run();
  expect((await readEditorialDocument(db, kv, 'page', 'returns'))!.title).toBe('Returns');
  kv.map.delete(editorialKey('page', 'returns'));
  expect((await readEditorialDocument(db, kv, 'page', 'returns'))!.title).toBe('Returns');
  const pinned = await readListingRef(db, kv, 'c');
  await db.prepare("UPDATE collections SET description='New metadata' WHERE id='c'").run();
  await buildCatalogReadModels(db, kv);
  expect((await getPublishedCollection(db, env, 'tees'))!.collection.description).toBe(
    'New metadata'
  );
  kv.map.set('catalog:r1:listing:c:current', JSON.stringify(pinned));
  expect((await getPublishedCollection(db, env, 'tees'))!.collection.description).toBe(
    'Published collection'
  );
});

it('complete title/ID-ordered discovery and pinned collection SEO survive missing KV', async () => {
  const statements = [];
  for (let i = 0; i < 51; i++)
    statements.push(
      db
        .prepare(
          "INSERT INTO collections(id,slug,title,description,kind,created_at) VALUES(?,?,?,'Original','manual','2026-01-01')"
        )
        .bind(`c${String(i).padStart(2, '0')}`, `c-${i}`, 'Tied title')
    );
  await db.batch(statements);
  await buildCatalogReadModels(db, kv);
  const env = { CATALOG_KV: kv as never };
  const first = await listAllCollections(db, env, 1),
    second = await listAllCollections(db, env, 2);
  expect(first.total).toBe(51);
  expect(first.collections).toHaveLength(48);
  expect(second.collections).toHaveLength(3);
  expect([...first.collections, ...second.collections].map((c) => c.id)).toEqual(
    Array.from({ length: 51 }, (_, i) => `c${String(i).padStart(2, '0')}`)
  );
  kv.map.clear();
  expect((await listAllCollections(db, env, 2)).collections.map((c) => c.id)).toEqual(
    second.collections.map((c) => c.id)
  );
});

async function editCollectionDuringIndexScan() {
  await db
    .prepare(
      "INSERT INTO collections(id,slug,title,description,kind,created_at) VALUES('c','tees','Tees','Original','manual','2026-01-01')"
    )
    .run();
  const write = kv.put.bind(kv);
  const scan = { edited: false };
  kv.put = async (key, value) => {
    await write(key, value);
    if (
      !scan.edited &&
      key.startsWith('catalog:r1:listing:@collections:page:') &&
      JSON.parse(value).items.length
    ) {
      scan.edited = true;
      await db
        .prepare("UPDATE collections SET title='Changed during index scan' WHERE id='c'")
        .run();
    }
  };
  return scan;
}

it(
  'the actual queue resumes a changed discovery index within the shared invocation budget',
  { timeout: 180_000 },
  async () => {
    const scan = await editCollectionDuringIndexScan();
    const queue = await catalogQueueHarness(db, kv);
    vi.useFakeTimers({ toFake: ['Date'] });
    let complete = false;
    for (let i = 0; i < 180; i++) {
      const step = await queue.deliver();
      expect(step.retried).toBe(false);
      if (step.acked && !step.continued) {
        complete = true;
        break;
      }
    }
    expect(complete).toBe(true);
    expect(scan.edited).toBe(true);
    expect(
      (await db
        .prepare('SELECT COUNT(*) AS n FROM catalog_ref_state WHERE pending_payload IS NOT NULL')
        .first<{ n: number }>())!.n
    ).toBe(0);
    expect((await getHomeCollections(db, { CATALOG_KV: kv as never }))[0]!.title).toBe(
      'Changed during index scan'
    );
    expect((await listAllCollections(db, { CATALOG_KV: kv as never })).collections[0]!.slug).toBe(
      'tees'
    );
    expect((await listAllCollections(db, { CATALOG_KV: kv as never })).collections[0]!.title).toBe(
      'Changed during index scan'
    );
  }
);

it(
  'a collection edit during an index scan does not stall a later product publish',
  { timeout: 300_000 },
  async () => {
    const scan = await editCollectionDuringIndexScan();
    const queue = await catalogQueueHarness(db, kv);
    vi.useFakeTimers({ toFake: ['Date'] });
    let complete = false;
    for (let i = 0; i < 260 && !complete; i++) {
      if (i === 80)
        await db.prepare("UPDATE products SET title='Edited after index scan' WHERE id='p1'").run();
      const step = await queue.deliver();
      complete = i >= 80 && step.acked && !step.continued;
    }
    expect(scan.edited).toBe(true);
    expect(complete).toBe(true);
    expect((await readProductDocument(db, kv, 'tee'))?.title).toBe('Edited after index scan');
  }
);

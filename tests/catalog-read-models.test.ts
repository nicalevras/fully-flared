import { beforeEach, afterEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import {
  getStorefrontLayout,
  readListingPage,
  readProductDocument,
} from '../web/src/server/catalog-read';
import { getFeaturedRails } from '../web/src/server/catalog-discovery';
import { repairPendingDeliveries } from '../web/src/server/catalog-publisher';
import { CatalogBudget } from '../web/src/server/catalog-exec';
import { ALL_LISTING } from '../web/src/server/catalog-models';
import { present, published } from './helpers/fixtures';

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

async function product(id: string, slug: string, title: string, createdAt: string, price = 1000) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO products(id,slug,title,description,status,created_at,updated_at) VALUES(?,?,?,'desc','active',?,?)"
      )
      .bind(id, slug, title, createdAt, createdAt),
    db
      .prepare(
        "INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) VALUES(?,?,?,?,?,'active',?)"
      )
      .bind(`v-${id}`, id, `SKU-${id}`, 'Default', price, createdAt),
    db
      .prepare('INSERT INTO stock(sku,on_hand,reserved,updated_at) VALUES(?,50,0,?)')
      .bind(`SKU-${id}`, createdAt),
  ]);
}

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  kv = new FakeKv();
});
afterEach(async () => {
  await dispose();
});

it('publishes cards, product documents and paged listings without inventory data', async () => {
  await product('p1', 'alpha', 'Alpha', '2026-01-03T00:00:00.000Z');
  await product('p2', 'beta', 'Beta', '2026-01-02T00:00:00.000Z');
  await product('p3', 'gamma', 'Gamma', '2026-01-02T00:00:00.000Z');
  const result = await buildCatalogReadModels(db, kv);
  expect(result.products).toBe(3);

  const page = await readListingPage(db, kv, ALL_LISTING, 1);
  // created_at DESC, id DESC: p1 newest; p3 before p2 on the tie.
  expect(page?.cards.map((c) => c.id)).toEqual(['p1', 'p3', 'p2']);
  expect(page?.total).toBe(3);
  expect(JSON.stringify(page)).not.toContain('available');

  const doc = published(await readProductDocument(db, kv, 'alpha'));
  expect(doc.slug).toBe('alpha');
  expect(doc.variants[0]?.sku).toBe('SKU-p1');
  expect(JSON.stringify(doc)).not.toContain('available');
  expect(doc.revision).toBeTruthy();

  const cardRow = await db
    .prepare('SELECT card_json FROM catalog_cards WHERE product_id=?')
    .bind('p1')
    .first<{ card_json: string }>();
  expect(JSON.parse(present(cardRow).card_json)).toMatchObject({ slug: 'alpha', priceCents: 1000 });
});

it('paginates listings at 24 (home) and 48 (collections) with stable ordering', async () => {
  for (let i = 1; i <= 30; i++)
    await product(
      `p${i}`,
      `prod-${i}`,
      `Prod ${i}`,
      `2026-01-${String(31 - Math.floor(i / 2)).padStart(2, '0')}T00:00:00.000Z`
    );
  await db
    .prepare(
      "INSERT INTO collections(id,slug,title,kind,created_at) VALUES('c1','manual-one','Manual','manual','2026-01-01')"
    )
    .run();
  for (let i = 1; i <= 30; i++)
    await db
      .prepare('INSERT INTO product_collections(product_id,collection_id) VALUES(?,?)')
      .bind(`p${i}`, 'c1')
      .run();
  await buildCatalogReadModels(db, kv);
  const home1 = await readListingPage(db, kv, ALL_LISTING, 1);
  const home2 = await readListingPage(db, kv, ALL_LISTING, 2);
  expect(home1?.cards).toHaveLength(24);
  expect(home2?.cards).toHaveLength(6);
  expect(home1?.pageCount).toBe(2);
  const col1 = await readListingPage(db, kv, 'c1', 1);
  expect(col1?.cards).toHaveLength(30);
  expect(col1?.pageCount).toBe(1);
  const seen = new Set([...(home1?.cards ?? []), ...(home2?.cards ?? [])].map((c) => c.id));
  expect(seen.size).toBe(30);
});

it('evaluates rule collections literally, including % in titles', async () => {
  await product('p1', 'a', '50% off sale', '2026-01-03T00:00:00.000Z', 500);
  await product('p2', 'b', '500 sale', '2026-01-02T00:00:00.000Z', 1500);
  await product('p3', 'c', '50 percent', '2026-01-01T00:00:00.000Z', 700);
  await db.batch([
    db.prepare(
      `INSERT INTO collections(id,slug,title,kind,rule_json,created_at) VALUES('ct','t','T','rule','{"type":"title_contains","value":"50%"}','2026-01-01')`
    ),
    db.prepare(
      `INSERT INTO collections(id,slug,title,kind,rule_json,created_at) VALUES('cp','p','P','rule','{"type":"price_lte","value":1000}','2026-01-01')`
    ),
  ]);
  await buildCatalogReadModels(db, kv);
  const byTitle = await readListingPage(db, kv, 'ct', 1);
  expect(byTitle?.cards.map((c) => c.id)).toEqual(['p1']);
  const byPrice = await readListingPage(db, kv, 'cp', 1);
  expect(byPrice?.cards.map((c) => c.id).sort()).toEqual(['p1', 'p3']);
});

it('a rebuild with no changes is a no-op; a single edit republishes only its pages', async () => {
  await product('p1', 'alpha', 'Alpha', '2026-01-02T00:00:00.000Z');
  await product('p2', 'beta', 'Beta', '2026-01-01T00:00:00.000Z');
  const first = await buildCatalogReadModels(db, kv);
  expect(first.kvPuts).toBeGreaterThan(0);
  kv.puts = 0;
  const second = await buildCatalogReadModels(db, kv);
  expect(second.kvPuts).toBe(0);
  expect(second.cardsChanged).toBe(0);
  const gen = await db
    .prepare('SELECT generation FROM catalog_listings WHERE listing_id=? AND active=1')
    .bind(ALL_LISTING)
    .first<{ generation: number }>();
  expect(gen?.generation).toBe(1);

  await db.prepare("UPDATE products SET title='Alpha v2' WHERE id='p1'").run();
  const third = await buildCatalogReadModels(db, kv);
  expect(third.docsChanged).toBe(1);
  const page = await readListingPage(db, kv, ALL_LISTING, 1);
  expect(page?.generation).toBe(2);
  expect(page?.cards[0]?.title).toBe('Alpha v2');
  // Product-to-page lookup identifies the containing pages for p1.
  const lookup = await db
    .prepare(
      'SELECT listing_id, page FROM catalog_page_products WHERE product_id=? AND generation=2'
    )
    .bind('p1')
    .all<{ listing_id: string; page: number }>();
  expect(lookup.results).toEqual([{ listing_id: ALL_LISTING, page: 1 }]);
  // Previous generation is retained as the immediate fallback.
  const gens = await db
    .prepare('SELECT COUNT(*) AS n FROM catalog_listings WHERE listing_id=?')
    .bind(ALL_LISTING)
    .first<{ n: number }>();
  expect(gens?.n).toBe(2);
});

it('home rails render featured collections from KV alone, in rank order', async () => {
  for (let i = 1; i <= 10; i++)
    await product(
      `p${i}`,
      `item-${i}`,
      `Item ${i}`,
      `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`
    );
  await db.batch([
    db.prepare(
      "INSERT INTO collections(id,slug,title,description,kind,featured_rank,created_at) VALUES('c1','tees','Tees','','manual',1,'2026-01-01'),('c2','bags','Bags','','manual',2,'2026-01-01'),('c3','caps','Caps','','manual',2,'2026-01-01'),('c4','empty','Empty','','manual',3,'2026-01-01'),('c5','hats','Hats','','manual',NULL,'2026-01-01')"
    ),
    db.prepare(
      "INSERT INTO product_collections(product_id,collection_id) SELECT id,'c1' FROM products UNION ALL SELECT 'p1','c2' UNION ALL SELECT 'p2','c3' UNION ALL SELECT 'p3','c5'"
    ),
  ]);
  await buildCatalogReadModels(db, kv);
  await repairPendingDeliveries(db, kv, (key, value) => kv.put(key, value), {
    limit: 20,
    budget: new CatalogBudget(),
  });
  let queries = 0;
  const noD1 = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return () => {
          queries++;
          throw new Error('Unexpected D1 query');
        };
      return Reflect.get(target, key);
    },
  });
  const env = { CATALOG_KV: kv };
  const layout = await getStorefrontLayout(noD1, env);
  expect(layout.featured.map((c) => c.slug)).toEqual(['tees', 'bags', 'caps', 'empty']);
  const rails = await getFeaturedRails(noD1, env, layout.featured);
  expect(rails.map((r) => [r.slug, r.products.length])).toEqual([
    ['tees', 8],
    ['bags', 1],
    ['caps', 1],
  ]);
  expect(rails[0]?.products.map((p) => p.slug)).toEqual(
    [10, 9, 8, 7, 6, 5, 4, 3].map((i) => `item-${i}`)
  );
  expect(queries).toBe(0);
});

it('KV miss or corrupt values fall back to the exact D1 payload', async () => {
  await product('p1', 'alpha', 'Alpha', '2026-01-01T00:00:00.000Z');
  await buildCatalogReadModels(db, kv);
  const viaKv = await readListingPage(db, kv, ALL_LISTING, 1);
  kv.map.clear();
  const viaD1 = await readListingPage(db, kv, ALL_LISTING, 1);
  expect(viaD1).toEqual(viaKv);
  // Corrupt every KV value: readers still serve the D1 payload.
  await buildCatalogReadModels(db, kv);
  for (const key of [...kv.map.keys()]) kv.map.set(key, '{broken');
  const viaFallback = await readListingPage(db, kv, ALL_LISTING, 1);
  expect(viaFallback?.cards.map((c) => c.id)).toEqual(['p1']);
  expect(published(await readProductDocument(db, kv, 'alpha')).slug).toBe('alpha');
});

it(
  'builds a 10,000-product catalogue in bounded pages with no oversized values',
  { timeout: 240_000 },
  async () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      i,
      id: `bp${i}`,
      slug: `bulk-${i}`,
      created: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
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
    const t0 = Date.now();
    const result = await buildCatalogReadModels(db, kv);
    console.warn(
      `10k build: products=${result.products} pages=${result.pages} kvPuts=${result.kvPuts} ms=${Date.now() - t0}`
    );
    expect(result.products).toBe(10_000);
    const home = await readListingPage(db, kv, ALL_LISTING, 417);
    expect(home?.total).toBe(10_000);
    expect(home?.pageCount).toBe(417);
    expect(home?.cards).toHaveLength(16);
    let maxValue = 0;
    for (const v of kv.map.values()) maxValue = Math.max(maxValue, v.length);
    expect(maxValue).toBeLessThan(128 * 1024);
    kv.puts = 0;
    const again = await buildCatalogReadModels(db, kv);
    expect(again.kvPuts).toBe(0);
  }
);
import { buildCatalogReadModels } from './helpers/catalog-driver';

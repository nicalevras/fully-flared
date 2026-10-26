import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { adminProductDiscovery } from '../web/src/server/admin-product-discovery';
import {
  compareProductTitles,
  foldProductTitle,
  normalizeProductSearch,
} from '../web/src/lib/product-search';

let db: D1Database;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => {
  await dispose();
});

async function product(
  id: string,
  title: string,
  createdAt = '2026-01-01',
  updatedAt = '2026-01-01',
  status = 'draft'
) {
  await db
    .prepare(
      'INSERT INTO products(id,slug,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?)'
    )
    .bind(id, id, title, status, createdAt, updatedAt)
    .run();
}
async function variant(id: string, productId: string, sku: string, price = 1000, title = 'Default') {
  await db
    .prepare(
      'INSERT INTO variants(id,product_id,sku,title,price_cents,created_at) VALUES(?,?,?,?,?,?)'
    )
    .bind(id, productId, sku, title, price, '2026')
    .run();
}

it('implements the SQLite NOCASE title contract in the shared comparator', () => {
  expect(foldProductTitle('AbC ÉXYZ')).toBe('abc Éxyz');
  const rows = [
    { title: 'banana', id: 'b' },
    { title: 'APPLE', id: 'a3' },
    { title: 'apple', id: 'a2' },
    { title: 'Apple', id: 'a1' },
  ];
  expect([...rows].sort(compareProductTitles).map((row) => row.id)).toEqual([
    'a1',
    'a2',
    'a3',
    'b',
  ]);
});

it('sorts browse by title with NOCASE ties broken by id, forward and backward', async () => {
  await product('a2', 'apple');
  await product('a1', 'Apple');
  await product('a3', 'APPLE');
  await product('e1', 'eclair');
  await product('e2', 'Éclair');
  await product('b1', 'Banana');
  const result = await adminProductDiscovery(db, { sort: 'title' });
  expect(result.products.map((row) => row.id)).toEqual(['a1', 'a2', 'a3', 'b1', 'e1', 'e2']);
});

it('pages title-sorted browse across a case-tie boundary without duplicates or gaps', async () => {
  await db
    .prepare(
      "WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<52) INSERT INTO products(id,slug,title,created_at,updated_at) SELECT printf('p%03d',n),printf('p%03d',n),'banana','2026','2026' FROM c"
    )
    .run();
  await product('a2', 'apple');
  await product('a1', 'Apple');
  await product('a3', 'APPLE');
  const first = await adminProductDiscovery(db, { sort: 'title' });
  const second = await adminProductDiscovery(db, { sort: 'title', cursor: first.nextCursor });
  const ids = [...first.products, ...second.products].map((row) => row.id);
  expect(first.products.slice(0, 3).map((row) => row.id)).toEqual(['a1', 'a2', 'a3']);
  expect(new Set(ids).size).toBe(55);
  expect(ids).toHaveLength(55);
  const back = await adminProductDiscovery(db, { sort: 'title', cursor: second.previousCursor });
  expect(back.products.map((row) => row.id)).toEqual(first.products.map((row) => row.id));
});

it('sorts by oldest and by recently updated with cursor paging', async () => {
  await product('old', 'One', '2024-01-01', '2026-06-01');
  await product('mid', 'Two', '2025-01-01', '2024-06-01');
  await product('new', 'Three', '2026-01-01', '2025-06-01');
  expect((await adminProductDiscovery(db, { sort: 'oldest' })).products.map((r) => r.id)).toEqual([
    'old',
    'mid',
    'new',
  ]);
  expect((await adminProductDiscovery(db, { sort: 'updated' })).products.map((r) => r.id)).toEqual([
    'old',
    'new',
    'mid',
  ]);
  expect((await adminProductDiscovery(db, { sort: 'newest' })).products.map((r) => r.id)).toEqual([
    'new',
    'mid',
    'old',
  ]);
});

it('filters by product status in browse and in every search mode', async () => {
  await product('act', 'Red Hat', '2026', '2026', 'active');
  await product('drf', 'Red Hat', '2026', '2026', 'draft');
  await product('arc', 'Red Hat', '2026', '2026', 'archived');
  await variant('v1', 'act', 'HAT-1');
  await variant('v2', 'drf', 'HAT-2');
  await variant('v3', 'arc', 'HAT-3');
  expect((await adminProductDiscovery(db, { status: 'active' })).products.map((r) => r.id)).toEqual([
    'act',
  ]);
  expect(
    (await adminProductDiscovery(db, { q: 'Red Hat', mode: 'title', status: 'draft' })).products.map(
      (r) => r.id
    )
  ).toEqual(['drf']);
  expect(
    (await adminProductDiscovery(db, { q: 'HAT-', mode: 'sku-prefix', status: 'archived' })).products.map(
      (r) => r.id
    )
  ).toEqual(['arc']);
  expect(
    (await adminProductDiscovery(db, { q: 'HAT-1', mode: 'sku-exact', status: 'draft' })).products
  ).toEqual([]);
  expect(
    (await adminProductDiscovery(db, { q: 'Red Hat', mode: 'title', status: 'all' })).products
  ).toHaveLength(3);
});

it('sorts search candidates with the same contract and resets paging when sort changes', async () => {
  await product('b', 'Hat Banana', '2024');
  await product('a', 'Hat apple', '2026');
  await product('c', 'Hat Cherry', '2025');
  const byTitle = await adminProductDiscovery(db, { q: 'Hat', mode: 'title', sort: 'title' });
  expect(byTitle.products.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  const first = await adminProductDiscovery(db, { q: 'Hat', mode: 'title', sort: 'newest' });
  expect(
    normalizeProductSearch({ q: 'Hat', mode: 'title', sort: 'oldest', cursor: first.nextCursor })
      .cursor
  ).toBeUndefined();
  expect(
    normalizeProductSearch({ q: 'Hat', mode: 'title', status: 'active', cursor: first.nextCursor })
      .cursor
  ).toBeUndefined();
});

it('rejects version 1 cursors and returns the first page with state preserved', async () => {
  await product('one', 'One');
  const v1 = btoa(
    JSON.stringify({ v: 1, q: '', mode: null, direction: 'next', createdAt: '2026', id: 'one' })
  );
  const normalized = normalizeProductSearch({ cursor: v1, status: 'draft', sort: 'title' });
  expect(normalized).toMatchObject({ status: 'draft', sort: 'title', cursor: undefined });
  const result = await adminProductDiscovery(db, { cursor: v1, sort: 'title' });
  expect(result.products.map((r) => r.id)).toEqual(['one']);
});

it('derives matched SKUs from candidate rows, sorted by SKU, capped at three', async () => {
  await product('p', 'Shoes');
  await variant('v5', 'p', 'SHOE-05', 100, 'Red');
  await variant('v2', 'p', 'SHOE-02', 100, 'Blue');
  await variant('v4', 'p', 'SHOE-04', 100, 'Green');
  await variant('v1', 'p', 'SHOE-01', 100, 'Black');
  await variant('v3', 'p', 'SHOE-03', 100, 'White');
  const first = await adminProductDiscovery(db, { q: 'SHOE-', mode: 'sku-prefix' });
  expect(first.products[0]?.matched_skus).toEqual([
    { sku: 'SHOE-01', title: 'Black' },
    { sku: 'SHOE-02', title: 'Blue' },
    { sku: 'SHOE-03', title: 'White' },
  ]);
  expect(first.products[0]?.matched_sku_count).toBe(5);
  const again = await adminProductDiscovery(db, { q: 'SHOE-', mode: 'sku-prefix' });
  expect(again.products[0]?.matched_skus).toEqual(first.products[0]?.matched_skus);
  const titleSearch = await adminProductDiscovery(db, { q: 'Shoes', mode: 'title' });
  expect(titleSearch.products[0]?.matched_skus).toEqual([]);
  expect(titleSearch.products[0]?.matched_sku_count).toBe(0);
});

it('projects price range and total variant count in one row', async () => {
  await product('p', 'Priced');
  await variant('v1', 'p', 'P-1', 900);
  await variant('v2', 'p', 'P-2', 400);
  await db
    .prepare("INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) VALUES('v3','p','P-3','Draft',100,'draft','2026')")
    .run();
  const result = await adminProductDiscovery(db, {});
  expect(result.products[0]).toMatchObject({
    price_cents: 400,
    max_price_cents: 900,
    variant_count: 3,
  });
  await product('bare', 'Bare');
  const bare = (await adminProductDiscovery(db, { q: 'Bare', mode: 'title' })).products[0];
  expect(bare).toMatchObject({ price_cents: null, max_price_cents: null, variant_count: 0 });
});

it('creates the title indexes with NOCASE collation in the migrated schema', async () => {
  const result = await db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND name IN ('products_title_id_idx','products_status_title_id_idx') ORDER BY name"
    )
    .all<{ name: string; sql: string }>();
  expect(result.results).toHaveLength(2);
  for (const row of result.results) expect(row.sql).toContain('COLLATE NOCASE');
  const plan = await db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM products WHERE title COLLATE NOCASE > ? ORDER BY title COLLATE NOCASE, id LIMIT 51"
    )
    .bind('Product 050000')
    .all<{ detail: string }>();
  expect(plan.results.map((row) => row.detail).join(' ')).toContain('SEARCH');
});

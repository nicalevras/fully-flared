import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { adminProductDiscovery } from '../web/src/server/admin-product-discovery';
import { normalizeProductSearch } from '../web/src/lib/product-search';

let db: D1Database;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => {
  await dispose();
});

async function product(id: string, title: string, createdAt = '2026') {
  await db
    .prepare('INSERT INTO products(id,slug,title,created_at,updated_at) VALUES(?,?,?,?,?)')
    .bind(id, id, title, createdAt, createdAt)
    .run();
}
async function variant(
  id: string,
  productId: string,
  sku: string,
  price = 1000,
  status = 'active'
) {
  await db
    .prepare(
      'INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) VALUES(?,?,?,?,?,?,?)'
    )
    .bind(id, productId, sku, id, price, status, '2026')
    .run();
}

it('browses 50 at a time with SQLite binary tie order and reusable cursors', async () => {
  await db
    .prepare(
      "WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<49) INSERT INTO products(id,slug,title,created_at,updated_at) SELECT printf('p%03d',n),printf('p%03d',n),'Row','2026','2026' FROM c"
    )
    .run();
  await product('z', 'Row');
  await product('Z', 'Row');
  await product('é', 'Row');
  const first = await adminProductDiscovery(db, {});
  const second = await adminProductDiscovery(db, { cursor: first.nextCursor });
  expect(first.products).toHaveLength(50);
  expect(first.products.slice(0, 3).map((row) => row.id)).toEqual(['é', 'z', 'p049']);
  expect(second.products.map((row) => row.id)).toEqual(['p001', 'Z']);
  expect(
    (await adminProductDiscovery(db, { cursor: second.previousCursor })).products.map(
      (row) => row.id
    )
  ).toEqual(first.products.map((row) => row.id));
  expect((await adminProductDiscovery(db, { cursor: 'bogus' })).products[0]?.id).toBe('é');
  await db.prepare("UPDATE products SET title='帽子'").run();
  const searched = await adminProductDiscovery(db, { q: '帽子', mode: 'title' });
  const searchedNext = await adminProductDiscovery(db, {
    q: '帽子',
    mode: 'title',
    cursor: searched.nextCursor,
  });
  expect(searched.products.map((row) => row.id)).toEqual(first.products.map((row) => row.id));
  expect(searchedNext.products.map((row) => row.id)).toEqual(second.products.map((row) => row.id));
  expect(
    (
      await adminProductDiscovery(db, {
        q: '帽子',
        mode: 'title',
        cursor: searchedNext.previousCursor,
      })
    ).products.map((row) => row.id)
  ).toEqual(searched.products.map((row) => row.id));
  expect(
    normalizeProductSearch({ q: 'different', mode: 'title', cursor: searched.nextCursor }).cursor
  ).toBeUndefined();

  expect(
    normalizeProductSearch({ q: 'Row', mode: 'title', cursor: first.nextCursor }).cursor
  ).toBeUndefined();
});

it('searches title terms only and binds cursors to the committed search', async () => {
  await product('one', 'Blue Hat', '2025');
  await product('two', 'Hat Blue', '2026');
  await product('other', 'Yellow Coat', '2027');
  await db.prepare("UPDATE products SET description='Blue Hat' WHERE id='other'").run();
  expect(
    (await adminProductDiscovery(db, { q: 'Blue Hat', mode: 'title' })).products.map(
      (row) => row.id
    )
  ).toEqual(['two', 'one']);
  expect((await adminProductDiscovery(db, { q: 'Absent Word', mode: 'title' })).products).toEqual(
    []
  );
  expect(
    (await adminProductDiscovery(db, { q: 'Blue OR Yellow', mode: 'title' })).products
  ).toEqual([]);
  expect(
    normalizeProductSearch({ q: 'Blue', mode: 'title', cursor: 'bad' }).cursor
  ).toBeUndefined();
});

it('uses case-sensitive SKU matching and projects only active variant price, stock and ready image', async () => {
  await product('p', 'One');
  await variant('v1', 'p', 'Ab-1', 900);
  await variant('v2', 'p', 'Ab-2', 400);
  await variant('v3', 'p', 'Ab-3', 100, 'draft');
  await db
    .prepare(
      "INSERT INTO stock(sku,on_hand,reserved,updated_at) VALUES('Ab-1',10,2,'2026'),('Ab-2',5,1,'2026'),('Ab-3',50,0,'2026')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO media(id,r2_key,filename,content_type,created_at,ready) VALUES('m2','ready','b','image/jpeg','2026',1)"
    )
    .run();
  await db
    .prepare("INSERT INTO product_media(product_id,media_id,position) VALUES('p','m2',1)")
    .run();
  const exact = await adminProductDiscovery(db, { q: 'Ab-1', mode: 'sku-exact' });
  expect(exact.products[0]).toMatchObject({
    id: 'p',
    price_cents: 400,
    available: 12,
    image_key: 'ready',
  });
  expect((await adminProductDiscovery(db, { q: 'ab-1', mode: 'sku-exact' })).products).toEqual([]);
  expect(
    (await adminProductDiscovery(db, { q: 'Ab-', mode: 'sku-prefix' })).products.map(
      (row) => row.id
    )
  ).toEqual(['p']);
  expect((await adminProductDiscovery(db, { q: 'ab-', mode: 'sku-prefix' })).products).toEqual([]);
});

it('asks for refinement before deduplication or hydration when one product has too many matching SKUs', async () => {
  await product('p', 'One');
  await db
    .prepare(
      "WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<1001) INSERT INTO variants(id,product_id,sku,title,price_cents,created_at) SELECT printf('v%04d',n),'p',printf('BULK-%04d',n),'Bulk',100,'2026' FROM c"
    )
    .run();
  const result = await adminProductDiscovery(db, { q: 'BULK-', mode: 'sku-prefix' });
  expect(result).toEqual({ products: [], nextCursor: null, previousCursor: null, state: 'refine' });
  expect(
    (await adminProductDiscovery(db, { q: 'BULK-0001', mode: 'sku-exact' })).products.map(
      (row) => row.id
    )
  ).toEqual(['p']);
});

it('projects a product with many child rows without multiplying the visible product row', async () => {
  await product('many', 'Skewed');
  await db
    .prepare(
      "WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<1000) INSERT INTO variants(id,product_id,sku,title,price_cents,created_at) SELECT printf('v%04d',n),'many',printf('S%04d',n),'Variant',n,'2026' FROM c"
    )
    .run();
  await db
    .prepare(
      "WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<50) INSERT INTO media(id,r2_key,filename,content_type,created_at) SELECT printf('m%02d',n),printf('k%02d',n),'x.jpg','image/jpeg','2026' FROM c"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO product_media(product_id,media_id,position) SELECT 'many',id,CAST(SUBSTR(id,2) AS INTEGER) FROM media"
    )
    .run();
  const result = await adminProductDiscovery(db, {});
  expect(result.products).toHaveLength(1);
  expect(result.products[0]).toMatchObject({
    id: 'many',
    price_cents: 1,
    available: 0,
    image_key: 'k01',
  });
});

it('handles punctuation, quotes and malformed title input without throwing', async () => {
  await product('cpp', 'C++ Shirt', '2026');
  await product('hat', 'New Wool & Hat', '2025');
  for (const q of [
    '"',
    "'",
    '+++',
    '()',
    ':',
    'A " B',
    '-',
    '*',
    '...',
    '!!!',
    'C++ AND (',
    'title:',
  ]) {
    const result = await adminProductDiscovery(db, { q, mode: 'title' });
    expect(Array.isArray(result.products)).toBe(true);
  }
  expect(
    (await adminProductDiscovery(db, { q: 'C++', mode: 'title' })).products.map((row) => row.id)
  ).toEqual(['cpp']);
  expect((await adminProductDiscovery(db, { q: '"', mode: 'title' })).products).toEqual([]);
  expect(
    (await adminProductDiscovery(db, { q: 'Wool Hat', mode: 'title' })).products.map(
      (row) => row.id
    )
  ).toEqual(['hat']);
  expect((await adminProductDiscovery(db, { q: '&', mode: 'title' })).products).toEqual([]);
});

it('refines a broad title search and succeeds when the search is narrowed', async () => {
  await db
    .prepare(
      "WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<1001) INSERT INTO products(id,slug,title,created_at,updated_at) SELECT printf('c%04d',n),printf('c%04d',n),'Common Shirt','2026','2026' FROM c"
    )
    .run();
  await product('unique', 'Common Unique Shirt', '2027');
  expect((await adminProductDiscovery(db, { q: 'Common', mode: 'title' })).state).toBe('refine');
  const narrowed = await adminProductDiscovery(db, { q: 'Common Unique', mode: 'title' });
  expect(narrowed.state).toBe('ready');
  expect(narrowed.products.map((row) => row.id)).toEqual(['unique']);
});

it('returns an empty page for a cursor whose remaining rows were deleted', async () => {
  await db
    .prepare(
      "WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<51) INSERT INTO products(id,slug,title,created_at,updated_at) SELECT printf('d%03d',n),printf('d%03d',n),'Row','2026','2026' FROM c"
    )
    .run();
  const first = await adminProductDiscovery(db, {});
  expect(first.products).toHaveLength(50);
  await db.prepare("DELETE FROM products WHERE id='d001'").run();
  const emptied = await adminProductDiscovery(db, { cursor: first.nextCursor });
  expect(emptied.products).toEqual([]);
  expect(emptied.nextCursor).toBeNull();
});

it('normalizes malformed search params to a safe empty or default search', () => {
  expect(normalizeProductSearch(null)).toEqual({ q: '', mode: null, status: 'all', sort: 'newest' });
  expect(normalizeProductSearch('nope')).toEqual({ q: '', mode: null, status: 'all', sort: 'newest' });
  expect(normalizeProductSearch({ q: 42, mode: 'title' })).toEqual({
    q: '',
    mode: null,
    status: 'all',
    sort: 'newest',
  });
  expect(normalizeProductSearch({ q: 'x'.repeat(201), mode: 'title' })).toEqual({
    q: '',
    mode: null,
    status: 'all',
    sort: 'newest',
  });
  expect(normalizeProductSearch({ q: ' Hat ', mode: 'bogus' })).toEqual({
    q: 'Hat',
    mode: 'title',
    status: 'all',
    sort: 'newest',
    cursor: undefined,
  });
  expect(normalizeProductSearch({ q: 'Hat', mode: 'sku-exact', cursor: 'bad' })).toEqual({
    q: 'Hat',
    mode: 'sku-exact',
    status: 'all',
    sort: 'newest',
    cursor: undefined,
  });
  expect(normalizeProductSearch({ status: 'bogus', sort: 'bogus' })).toEqual({
    q: '',
    mode: null,
    status: 'all',
    sort: 'newest',
  });
});

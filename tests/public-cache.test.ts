import { expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';
import {
  cacheTagsForPath,
  drainCatalogInvalidations,
  invalidationTags,
  publicCacheRequest,
  publicCacheResponse,
} from '../web/src/server/public-cache';
import { processCatalogWork } from '../web/src/server/catalog-publisher';

// Phase 4 policy surface: gateway classification, response storage
// policy, cache tags and the invalidation drain. Actual edge cache
// hits are a deployment acceptance gate; these tests pin the policy
// the edge executes. They replace tests/round2-cache.test.ts, which
// covered the retired Cache API wrapper.

const html = { headers: { accept: 'text/html' } };

it('classifies only ordinary public HTML GETs for the storefront', () => {
  for (const path of [
    '/',
    '/products/tee',
    '/collections/shoes',
    '/collections/shoes?page=2',
    '/pages/about',
    '/blog',
    '/blog/hello',
  ])
    expect(publicCacheRequest(new Request(`https://shop.test${path}`, html)), path).not.toBeNull();
  for (const path of [
    '/admin',
    '/account',
    '/cart',
    '/checkout',
    '/auth/login',
    '/api/checkout',
    '/_serverFn/test',
    '/search?q=tee',
    '/media/x.jpg',
    '/favicon.ico',
  ])
    expect(publicCacheRequest(new Request(`https://shop.test${path}`, html)), path).toBeNull();
  expect(
    publicCacheRequest(
      new Request('https://shop.test/', { method: 'POST', headers: { accept: 'text/html' } })
    )
  ).toBeNull();
  expect(
    publicCacheRequest(
      new Request('https://shop.test/', { headers: { accept: 'application/json' } })
    )
  ).toBeNull();
  expect(
    publicCacheRequest(
      new Request('https://shop.test/', {
        headers: { accept: 'text/html', upgrade: 'websocket' },
      })
    )
  ).toBeNull();
});

it('strips private and forwarding headers and tracking parameters only', () => {
  const forwarded = publicCacheRequest(
    new Request('https://shop.test/products/tee?page=2&utm_source=news&gclid=abc', {
      headers: {
        accept: 'text/html',
        cookie: 'cart=secret',
        authorization: 'Bearer secret',
        'x-forwarded-host': 'evil.test',
        'user-agent': 'test-agent',
      },
    })
  );
  expect(forwarded).not.toBeNull();
  expect(forwarded!.headers.has('cookie')).toBe(false);
  expect(forwarded!.headers.has('authorization')).toBe(false);
  expect(forwarded!.headers.has('x-forwarded-host')).toBe(false);
  expect(forwarded!.headers.get('user-agent')).toBe('test-agent');
  const url = new URL(forwarded!.url);
  expect(url.searchParams.get('page')).toBe('2');
  expect(url.searchParams.has('utm_source')).toBe(false);
  expect(url.searchParams.has('gclid')).toBe(false);
});

it('derives cache tags from the route scope', () => {
  expect(cacheTagsForPath('/')).toEqual(['layout', 'listing-all']);
  expect(cacheTagsForPath('/products/tee')).toEqual(['layout', 'product-tee']);
  expect(cacheTagsForPath('/collections/shoes')).toEqual(['layout', 'listing-shoes']);
  expect(cacheTagsForPath('/collections')).toEqual(['layout']);
  expect(cacheTagsForPath('/pages/about')).toEqual(['layout', 'editorial-about']);
  expect(cacheTagsForPath('/blog')).toEqual(['layout', 'editorial-index']);
  expect(cacheTagsForPath('/blog/hello')).toEqual(['layout', 'editorial-hello']);
});

it('stores only successful private-free HTML, for a 60s shared TTL', () => {
  const ok = publicCacheResponse(
    new Response('<html>ok</html>', {
      headers: { 'content-type': 'text/html', 'cdn-cache-control': 'max-age=3600' },
    }),
    ['layout', 'product-tee']
  );
  expect(ok.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  // Route-level CDN TTLs from the old design are normalized to policy.
  expect(ok.headers.get('cdn-cache-control')).toBe('max-age=60');
  expect(ok.headers.get('cache-tag')).toBe('layout,product-tee');

  const cookie = publicCacheResponse(
    new Response('<html>ok</html>', {
      headers: { 'content-type': 'text/html', 'set-cookie': 'x=1' },
    }),
    ['layout']
  );
  expect(cookie.headers.get('cache-control')).toBe('private, no-store');
  expect(cookie.headers.has('cache-tag')).toBe(false);

  const missing = publicCacheResponse(
    new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }),
    ['layout']
  );
  expect(missing.headers.get('cache-control')).toBe('private, no-store');

  const redirect = publicCacheResponse(
    new Response(null, { status: 302, headers: { location: '/products/tee' } }),
    ['layout']
  );
  expect(redirect.headers.get('cache-control')).toBe('private, no-store');

  const json = publicCacheResponse(
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ['layout']
  );
  expect(json.headers.get('cache-control')).toBe('private, no-store');
});

it('maps invalidation scopes to purge tags, deduplicated', () => {
  expect(
    invalidationTags([
      { id: '1', scope: 'product', scopeId: 'tee' },
      { id: '2', scope: 'product', scopeId: 'tee' },
      { id: '3', scope: 'listing', scopeId: 'all' },
      { id: '4', scope: 'listing', scopeId: 'shoes' },
      { id: '5', scope: 'editorial', scopeId: 'hello' },
      { id: '6', scope: 'layout', scopeId: 'layout' },
      { id: '7', scope: 'unknown', scopeId: 'x' },
      { id: '8', scope: 'product', scopeId: '' },
    ])
  ).toEqual(['product-tee', 'listing-all', 'listing-shoes', 'editorial-hello', 'layout']);
});

it('drains invalidations only after a successful purge', async () => {
  const { db, dispose } = await createTestDb();
  try {
    await db
      .prepare(
        "INSERT INTO catalog_invalidations (id, scope, scope_id, created_at) VALUES ('i1', 'product', 'tee', '2026-01-01'), ('i2', 'listing', 'all', '2026-01-01')"
      )
      .run();
    const failing = vi.fn(async () => {
      throw new Error('purge unavailable');
    });
    const failed = await drainCatalogInvalidations(db, failing);
    expect(failed.drained).toBe(0);
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM catalog_invalidations').first<{ n: number }>())
        ?.n
    ).toBe(2);

    const purge = vi.fn(async () => ({}));
    const drained = await drainCatalogInvalidations(db, purge);
    expect(drained.drained).toBe(2);
    expect(purge).toHaveBeenCalledWith(['product-tee', 'listing-all']);
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM catalog_invalidations').first<{ n: number }>())
        ?.n
    ).toBe(0);
  } finally {
    await dispose();
  }
});

it('keeps unmappable invalidation rows instead of deleting them with the purged ones', async () => {
  const { db, dispose } = await createTestDb();
  try {
    await db
      .prepare(
        "INSERT INTO catalog_invalidations (id, scope, scope_id, created_at) VALUES ('i1', 'product', 'tee', '2026-01-01'), ('i2', 'unknown', 'x', '2026-01-01'), ('i3', 'product', '', '2026-01-01')"
      )
      .run();
    const purge = vi.fn(async () => ({}));
    const drained = await drainCatalogInvalidations(db, purge);
    expect(drained.drained).toBe(1);
    expect(purge).toHaveBeenCalledWith(['product-tee']);
    const remaining = await db
      .prepare('SELECT id FROM catalog_invalidations ORDER BY id')
      .all<{ id: string }>();
    expect(remaining.results.map((r) => r.id)).toEqual(['i2', 'i3']);
  } finally {
    await dispose();
  }
});

it('a hard-deleted post still invalidates its editorial document', async () => {
  const { db, dispose } = await createTestDb();
  const kv = {
    map: new Map<string, string>(),
    async get(key: string) {
      return this.map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      this.map.set(key, value);
    },
    async delete(key: string) {
      this.map.delete(key);
    },
  };
  try {
    await db
      .prepare(
        "INSERT INTO posts (id, slug, title, excerpt, content_html, status, published_at, created_at, updated_at) VALUES ('post1', 'hello-world', 'Hello', '', '<p>hi</p>', 'published', '2026-01-01', '2026-01-01', '2026-01-01')"
      )
      .run();
    const { processCatalogWork } = await import('../web/src/server/catalog-publisher');
    const { editorialKey } = await import('../web/src/server/catalog-models');
    await processCatalogWork(db, kv as never);
    expect(kv.map.has(editorialKey('post', 'hello-world'))).toBe(true);
    await db.prepare("DELETE FROM posts WHERE id = 'post1'").run();
    await processCatalogWork(db, kv as never);
    expect(kv.map.has(editorialKey('post', 'hello-world'))).toBe(false);
    const inv = await db
      .prepare("SELECT scope_id FROM catalog_invalidations WHERE scope = 'editorial'")
      .all<{ scope_id: string }>();
    expect(inv.results.map((r) => r.scope_id)).toContain('hello-world');
  } finally {
    await dispose();
  }
});

it('a due scheduled post is promoted and published by the catalog pass', async () => {
  const { db, dispose } = await createTestDb();
  const kv = {
    map: new Map<string, string>(),
    async get(key: string) {
      return this.map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      this.map.set(key, value);
    },
    async delete(key: string) {
      this.map.delete(key);
    },
  };
  try {
    await db
      .prepare(
        "INSERT INTO posts (id, slug, title, excerpt, content_html, status, published_at, created_at, updated_at) VALUES ('post2', 'due-post', 'Due', '', '<p>due</p>', 'scheduled', '2000-01-01T00:00:00.000Z', '2026-01-01', '2026-01-01')"
      )
      .run();
    const { processCatalogWork } = await import('../web/src/server/catalog-publisher');
    const { editorialKey } = await import('../web/src/server/catalog-models');
    await processCatalogWork(db, kv as never);
    const post = await db
      .prepare("SELECT status FROM posts WHERE id = 'post2'")
      .first<{ status: string }>();
    expect(post?.status).toBe('published');
    expect(kv.map.has(editorialKey('post', 'due-post'))).toBe(true);
  } finally {
    await dispose();
  }
});

it('publishing a product edit records the invalidations its pages need', async () => {
  const { db, dispose } = await createTestDb();
  const kv = {
    map: new Map<string, string>(),
    async get(key: string) {
      return this.map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      this.map.set(key, value);
    },
    async delete(key: string) {
      this.map.delete(key);
    },
  };
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) VALUES ('p1', 'tee', 'Tee', '', 'active', '2026-01-01', '2026-01-01')"
      ),
      db.prepare(
        "INSERT INTO variants (id, product_id, sku, title, price_cents, status, created_at) VALUES ('v1', 'p1', 'TEE-1', 'Default', 100, 'active', '2026-01-01')"
      ),
      db.prepare(
        "INSERT INTO stock (sku, on_hand, reserved, updated_at) VALUES ('TEE-1', 5, 0, '2026-01-01')"
      ),
    ]);
    await buildCatalogReadModels(db, kv);
    await db.prepare('DELETE FROM catalog_invalidations').run();

    await db.prepare("UPDATE products SET title = 'Tee V2' WHERE id = 'p1'").run();
    await processCatalogWork(db, kv);
    const rows = await db
      .prepare(
        'SELECT scope, scope_id AS scopeId FROM catalog_invalidations ORDER BY scope, scope_id'
      )
      .all<{ scope: string; scopeId: string }>();
    expect(rows.results).toContainEqual({ scope: 'product', scopeId: 'tee' });
    expect(rows.results).toContainEqual({ scope: 'listing', scopeId: 'all' });
    expect(invalidationTags(rows.results.map((r, i) => ({ id: String(i), ...r })))).toEqual(
      expect.arrayContaining(['product-tee', 'listing-all'])
    );
  } finally {
    await dispose();
  }
});
import { buildCatalogReadModels } from './helpers/catalog-driver';

import { expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';
import {
  cacheTagsForPath,
  drainCatalogInvalidations,
  invalidationTags,
  publicCacheRequest,
  publicCacheResponse,
  takePurgeToken,
} from '../web/src/server/public-cache';

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
    '/shop',
    '/shop?page=2',
    '/search?q=tee',
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
  for (const headers of [{}, { accept: '*/*' }])
    expect(publicCacheRequest(new Request('https://shop.test/', { headers }))).not.toBeNull();
});

it('gives each page one cache key: page 1 and home pages share the bare path', () => {
  const origin = 'https://shop.test';
  const key = (path: string) =>
    publicCacheRequest(new Request(origin + path, html))?.url.slice(origin.length);
  expect(key('/shop?page=1')).toBe('/shop');
  expect(key('/shop?page=abc')).toBe('/shop');
  expect(key('/shop?page=2&utm_source=x')).toBe('/shop?page=2');
  expect(key('/collections/shoes?page=1')).toBe('/collections/shoes');
  expect(key('/?page=3')).toBe('/');
  expect(key('/search?q=tee&utm_source=x&foo=1')).toBe('/search?q=tee');
  expect(key('/search?cursor=abc&q=tee&page=2')).toBe('/search?cursor=abc&q=tee');
});

it('strips private/forwarding headers and nonsemantic product parameters', () => {
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
  expect(url.searchParams.has('page')).toBe(false);
  expect(url.searchParams.has('utm_source')).toBe(false);
  expect(url.searchParams.has('gclid')).toBe(false);
});

it('derives cache tags from the route scope', () => {
  expect(cacheTagsForPath('/')).toEqual(['layout', 'listing-@featured', 'listing-@collections']);
  expect(cacheTagsForPath('/shop')).toEqual(['layout', 'listing-all']);
  expect(cacheTagsForPath('/search')).toEqual(['layout', 'listing-all']);
  expect(cacheTagsForPath('/products/tee')).toEqual(['layout', 'product-tee']);
  expect(cacheTagsForPath('/collections/shoes')).toEqual(['layout', 'listing-shoes']);
  expect(cacheTagsForPath('/collections')).toEqual(['layout', 'listing-@collections']);
  expect(cacheTagsForPath('/pages/about')).toEqual(['layout', 'editorial-about']);
  expect(cacheTagsForPath('/blog')).toEqual(['layout', 'editorial-index', 'listing-@posts']);
  expect(cacheTagsForPath('/blog/hello')).toEqual(['layout', 'editorial-hello']);
});

it('stores private-free HTML: pages for 60s, not-found pages for 30s', () => {
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
    ['layout', 'product-gone']
  );
  expect(missing.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=30');
  expect(missing.headers.get('cdn-cache-control')).toBe('max-age=30');
  expect(missing.headers.get('cache-tag')).toBe('layout,product-gone');

  const missingWithCookie = publicCacheResponse(
    new Response('nope', {
      status: 404,
      headers: { 'content-type': 'text/html', 'set-cookie': 'x=1' },
    }),
    ['layout']
  );
  expect(missingWithCookie.headers.get('cache-control')).toBe('private, no-store');

  const limited = publicCacheResponse(
    new Response('slow down', { status: 429, headers: { 'content-type': 'text/html' } }),
    ['layout']
  );
  expect(limited.headers.get('cache-control')).toBe('private, no-store');

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

it('edge-caches the blog RSS feed like the blog index, purged with it', () => {
  expect(
    publicCacheRequest(
      new Request('https://shop.test/blog/rss.xml', {
        headers: { accept: 'application/rss+xml, application/xml;q=0.9' },
      })
    )
  ).not.toBeNull();
  const tags = cacheTagsForPath('/blog/rss.xml');
  expect(tags).toEqual(cacheTagsForPath('/blog'));
  const feed = publicCacheResponse(
    new Response('<rss version="2.0"></rss>', {
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    }),
    tags
  );
  expect(feed.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  expect(feed.headers.get('cache-tag')).toBe('layout,editorial-index,listing-@posts');
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

it('purges at most 100 tags per call and keeps the rows of a rejected chunk', async () => {
  const { db, dispose } = await createTestDb();
  try {
    await db
      .prepare(
        "INSERT INTO catalog_invalidations (id, scope, scope_id, created_at) SELECT 'i'||value, 'product', 'p'||value, '2026-01-01' FROM json_each(?)"
      )
      .bind(JSON.stringify(Array.from({ length: 150 }, (_, i) => i)))
      .run();
    const purge = vi
      .fn<(tags: string[]) => Promise<unknown>>()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('rate limited'));
    const result = await drainCatalogInvalidations(db, purge);
    expect(purge.mock.calls.map(([tags]) => tags.length)).toEqual([100, 50]);
    expect(result.drained).toBe(100);
    const kept = await db
      .prepare("SELECT 'product-'||scope_id AS tag FROM catalog_invalidations")
      .all<{ tag: string }>();
    expect(kept.results.map((r) => r.tag).sort()).toEqual(purge.mock.calls[1]?.[0].sort());
  } finally {
    await dispose();
  }
});

it('gates purges with a durable 5-per-minute bucket of 25', async () => {
  const { db, dispose } = await createTestDb();
  try {
    const start = Date.now();
    const burst = [];
    for (let i = 0; i < 26; i++) burst.push(await takePurgeToken(db, start));
    expect(burst.filter(Boolean)).toHaveLength(25);
    expect(burst.at(-1)).toBe(false);
    expect(await takePurgeToken(db, start + 12_000)).toBe(true);
    expect(await takePurgeToken(db, start + 12_000)).toBe(false);

    await db
      .prepare(
        "INSERT INTO catalog_invalidations (id, scope, scope_id, created_at) VALUES ('i1', 'product', 'tee', '2026-01-01')"
      )
      .run();
    const purge = vi.fn(async () => ({}));
    expect((await drainCatalogInvalidations(db, purge)).drained).toBe(0);
    expect(purge).not.toHaveBeenCalled();
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

async function seedInvalidations(
  db: D1Database,
  rows: { tag: string; ref?: string; seq?: number }[],
  refs: { key: string; delivered: number; lastWriteAt: string }[] = []
) {
  await db.batch([
    ...refs.map(({ key, delivered, lastWriteAt }) =>
      db
        .prepare(
          'INSERT INTO catalog_ref_state (ref_key, committed_seq, delivered_seq, last_write_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(key, delivered + 1, delivered, lastWriteAt, '2026-01-01')
    ),
    ...rows.map(({ tag, ref, seq }, i) =>
      db
        .prepare(
          "INSERT INTO catalog_invalidations (id, scope, scope_id, ref_key, ref_seq, created_at) VALUES (?, 'product', ?, ?, ?, '2026-01-01')"
        )
        .bind(`i${i}`, tag, ref ?? null, seq ?? null)
    ),
  ]);
}

const pendingIds = async (db: D1Database) =>
  (
    await db.prepare('SELECT id FROM catalog_invalidations ORDER BY id').all<{ id: string }>()
  ).results.map((r) => r.id);

it('coalesces delivered rows into one purge and keeps rows not yet safe to delete', async () => {
  const { db, dispose } = await createTestDb();
  try {
    await seedInvalidations(
      db,
      [
        { tag: 'tee' },
        { tag: 'tee', ref: 'listing:a', seq: 1 },
        { tag: 'tee', ref: 'listing:a', seq: 1 },
        { tag: 'tee', ref: 'listing:a', seq: 2 },
        { tag: 'cap', ref: 'listing:late', seq: 1 },
      ],
      [
        { key: 'listing:a', delivered: 1, lastWriteAt: '2026-01-01T00:00:00.000Z' },
        { key: 'listing:late', delivered: 1, lastWriteAt: '2999-01-01T00:00:00.000Z' },
      ]
    );
    const purge = vi.fn(async () => ({}));
    const result = await drainCatalogInvalidations(db, purge);
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith(['product-tee', 'product-cap']);
    expect(result).toEqual({ drained: 3, tags: ['product-tee', 'product-cap'], more: false });
    // i3 waits for delivery of seq 2; i4's ref was delivered after the pass began.
    expect(await pendingIds(db)).toEqual(['i3', 'i4']);
  } finally {
    await dispose();
  }
});

it('a same-tag invalidation recorded while a purge is in flight survives that pass', async () => {
  const { db, dispose } = await createTestDb();
  try {
    await seedInvalidations(
      db,
      [{ tag: 'tee' }, { tag: 'tee', ref: 'listing:a', seq: 1 }],
      [{ key: 'listing:a', delivered: 1, lastWriteAt: '2026-01-01T00:00:00.000Z' }]
    );
    const purge = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await db.batch([
        db.prepare(
          "INSERT INTO catalog_invalidations (id, scope, scope_id, created_at) VALUES ('late-trigger', 'product', 'tee', strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
        ),
        db.prepare(
          "INSERT INTO catalog_invalidations (id, scope, scope_id, ref_key, ref_seq, created_at) VALUES ('late-delivered', 'product', 'tee', 'listing:a', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
        ),
        db.prepare(
          "INSERT INTO catalog_invalidations (id, scope, scope_id, ref_key, ref_seq, created_at) VALUES ('late-pending', 'product', 'tee', 'listing:a', 2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
        ),
      ]);
      return {};
    });
    expect(await drainCatalogInvalidations(db, purge)).toMatchObject({ drained: 2 });
    expect(purge).toHaveBeenCalledTimes(1);
    expect(await pendingIds(db)).toEqual(['late-delivered', 'late-pending', 'late-trigger']);
  } finally {
    await dispose();
  }
});

it('rows inserted during a purge survive it even when the database clock lags the Worker', async () => {
  const { db, dispose } = await createTestDb();
  try {
    await seedInvalidations(
      db,
      [{ tag: 'tee' }, { tag: 'tee', ref: 'listing:a', seq: 1 }],
      [{ key: 'listing:a', delivered: 1, lastWriteAt: '2026-01-01T00:00:00.000Z' }]
    );
    const purge = vi.fn(async () => {
      await db.batch([
        db.prepare(
          "INSERT INTO catalog_invalidations (id, scope, scope_id, created_at) VALUES ('skewed-trigger', 'product', 'tee', '2000-01-01T00:00:00.000Z')"
        ),
        db.prepare(
          "INSERT INTO catalog_invalidations (id, scope, scope_id, ref_key, ref_seq, created_at) VALUES ('skewed-delivered', 'product', 'tee', 'listing:a', 1, '2000-01-01T00:00:00.000Z')"
        ),
      ]);
      return {};
    });
    expect(await drainCatalogInvalidations(db, purge)).toMatchObject({ drained: 2 });
    expect(await pendingIds(db)).toEqual(['skewed-delivered', 'skewed-trigger']);
  } finally {
    await dispose();
  }
});

it('drains distinct tags across passes until the purge gate runs dry', async () => {
  const { db, dispose } = await createTestDb();
  try {
    await seedInvalidations(
      db,
      Array.from({ length: 250 }, (_, i) => ({ tag: `p${i}` }))
    );
    for (let i = 0; i < 23; i++) await takePurgeToken(db);
    const purge = vi.fn(async () => ({}));
    const passes = [];
    for (let pass = 0; pass < 3; pass++)
      passes.push(await drainCatalogInvalidations(db, purge, 100));
    expect(passes.map(({ drained, more }) => ({ drained, more }))).toEqual([
      { drained: 100, more: true },
      { drained: 100, more: true },
      { drained: 0, more: false },
    ]);
    expect(await pendingIds(db)).toHaveLength(50);
  } finally {
    await dispose();
  }
});

it('re-purges rows whose delete failed instead of losing them', async () => {
  const { db, dispose } = await createTestDb();
  try {
    await seedInvalidations(db, [{ tag: 'tee' }]);
    const failingDeletes = new Proxy(db, {
      get: (target, key) =>
        key === 'prepare'
          ? (sql: string) => {
              if (sql.startsWith('DELETE')) throw new Error('D1 unavailable');
              return target.prepare(sql);
            }
          : Reflect.get(target, key),
    });
    const purge = vi.fn(async () => ({}));
    await expect(drainCatalogInvalidations(failingDeletes, purge)).rejects.toThrow(
      'D1 unavailable'
    );
    expect(await pendingIds(db)).toEqual(['i0']);
    expect(await drainCatalogInvalidations(db, purge)).toMatchObject({ drained: 1 });
    expect(purge.mock.calls).toEqual([[['product-tee']], [['product-tee']]]);
    expect(await pendingIds(db)).toEqual([]);
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
    const { editorialKey } = await import('../web/src/server/catalog-models');
    await catalogWork(db, kv as never);
    expect(kv.map.has(editorialKey('post', 'hello-world'))).toBe(true);
    await db.prepare("DELETE FROM posts WHERE id = 'post1'").run();
    await catalogWork(db, kv as never);
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
    const { editorialKey } = await import('../web/src/server/catalog-models');
    await catalogWork(db, kv as never);
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
    await catalogWork(db, kv);
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
import { buildCatalogReadModels, catalogWork } from './helpers/catalog-driver';

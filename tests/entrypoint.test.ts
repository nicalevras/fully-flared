import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';

let db: D1Database, dispose: () => Promise<void>;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => {
  await dispose();
});

function fakeCtx(storefront: unknown) {
  return {
    waitUntil: () => {},
    exports: { PublicStorefront: storefront },
  };
}

it('gateway forwards only classified public HTML to the storefront with props and a sanitized request', async () => {
  const { default: worker } = await import('../web/src/server');
  const seen: { props?: unknown; request?: Request } = {};
  const storefront = Object.assign(
    (opts: { props: { store: string } }) => {
      seen.props = opts.props;
      return {
        fetch: async (request: Request) => {
          seen.request = request;
          return new Response('<html>public</html>', {
            headers: { 'content-type': 'text/html' },
          });
        },
      };
    },
    { purgeInvalidations: async () => {} }
  );
  const response = await worker.fetch(
    new Request('https://Shop.Test/products/tee?utm_source=news&page=2', {
      headers: { accept: 'text/html', cookie: 'cart=secret' },
    }),
    { DB: db } as never,
    fakeCtx(storefront) as never
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('public');
  // Store identity travels in ctx.props (hostname lowercased).
  expect(seen.props).toEqual({ store: 'shop.test' });
  // The forwarded request is sanitized: no cookies, no tracking params.
  expect(seen.request?.headers.has('cookie')).toBe(false);
  const url = new URL(seen.request!.url);
  expect(url.searchParams.has('utm_source')).toBe(false);
  expect(url.searchParams.get('page')).toBe('2');
  // Gateway security headers wrap the storefront response.
  expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");

  // A private path never reaches the storefront entrypoint.
  const limited = await worker.fetch(
    new Request('https://shop.test/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    { DB: db } as never,
    fakeCtx(storefront) as never
  );
  expect(limited.status).toBe(503); // fail-closed without a limiter binding
});

it('gateway falls back to direct rendering when the storefront throws', async () => {
  const { default: worker } = await import('../web/src/server');
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  const storefront = Object.assign(
    () => ({
      fetch: async () => {
        throw new Error('storefront down');
      },
    }),
    { purgeInvalidations: async () => {} }
  );
  try {
    const response = await worker.fetch(
      new Request('https://shop.test/products/tee', { headers: { accept: 'text/html' } }),
      { DB: db } as never,
      fakeCtx(storefront) as never
    );
    // The gateway caught the storefront failure and rendered directly
    // (the real TanStack entry returns its harness 500 here; in
    // production it renders the page). The key evidence is the
    // logged failure plus a wrapped response, not a thrown error.
    expect(errors.some((e) => e.includes('public_storefront_failed'))).toBe(true);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  } finally {
    spy.mockRestore();
  }
});

it('catalog queue jobs drain purges through the cache-owning entrypoint', async () => {
  const { default: worker } = await import('../web/src/server');
  await db
    .prepare(
      "INSERT INTO catalog_invalidations (id, scope, scope_id, created_at) VALUES ('i1', 'product', 'tee', '2026-01-01')"
    )
    .run();
  const purged: string[][] = [];
  const storefront = Object.assign(() => ({ fetch: async () => new Response('x') }), {
    purgeInvalidations: async (tags: string[]) => {
      purged.push(tags);
    },
  });
  await worker.queue(
    {
      queue: 'store-catalog',
      messages: [{ body: { type: 'catalog.rebuild' }, ack: () => {}, retry: () => {} }],
    } as never,
    {
      DB: db,
      CATALOG_JOBS: { send: async () => {} },
      REALTIME: { getByName: () => ({ broadcast: async () => {} }) },
    } as never,
    fakeCtx(storefront) as never
  );
  expect(purged).toEqual([['product-tee']]);
  expect(
    (await db.prepare('SELECT COUNT(*) AS n FROM catalog_invalidations').first<{ n: number }>())?.n
  ).toBe(0);
});

it('PublicStorefront purges through its own cache handle and refuses without one', async () => {
  // Fetch tagging policy itself is covered through publicCacheResponse
  // in tests/public-cache.test.ts; the TanStack entry cannot render
  // under this harness, so this pins the purge RPC surface instead.
  const { PublicStorefront } = await import('../web/src/server/public-storefront');
  const purge = vi.fn(async () => {});
  const ep = new PublicStorefront({ cache: { purge } } as never, {} as never);
  await ep.purgeInvalidations(['layout']);
  expect(purge).toHaveBeenCalledWith({ tags: ['layout'] });
  await ep.purgeInvalidations([]);
  expect(purge).toHaveBeenCalledTimes(1); // empty tag list is a no-op

  const noCache = new PublicStorefront({} as never, {} as never);
  await expect(noCache.purgeInvalidations(['layout'])).rejects.toThrow(
    'Workers Cache API unavailable'
  );
});

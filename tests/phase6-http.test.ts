import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { env } from './helpers/cloudflare-workers-stub';
import { privateResponse } from '../web/src/server/public-cache';
import { SVG_CSP } from '../web/src/lib/image-input';
import { roles } from '../web/src/lib/permissions';
import { requireStaffPermission } from '../web/src/server/session';

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  env.DB = db;
});
afterEach(async () => {
  delete env.DB;
  delete env.MEDIA;
  await dispose();
});

describe('M1: media is cacheable for signed-in shoppers', () => {
  function r2(keys: string[], contentType = 'image/jpeg') {
    return {
      get: async (key: string) =>
        keys.includes(key)
          ? {
              body: 'bytes',
              httpEtag: `"${key}"`,
              writeHttpMetadata: (h: Headers) => h.set('Content-Type', contentType),
            }
          : null,
    };
  }
  async function media(path: string, objects: string[], contentType = 'image/jpeg', etag = '') {
    await db
      .prepare(
        "INSERT INTO media(id,r2_key,filename,content_type,alt_text,created_at) VALUES('m1','img-1.jpg','img-1.jpg','image/jpeg','',?)"
      )
      .bind(new Date().toISOString())
      .run();
    env.MEDIA = r2(objects, contentType);
    const { Route } = await import('../web/src/routes/media/$key');
    const handler = Route.options.server!.handlers!.GET! as (ctx: {
      request: Request;
      params: { key: string };
    }) => Promise<Response>;
    return handler({
      request: new Request(`https://shop.test${path}`, {
        headers: { cookie: 'session=abc', 'If-None-Match': etag },
      }),
      params: { key: 'img-1.jpg' },
    });
  }

  it.each(['', '"img-1.jpg"'])(
    'protects SVG delivery including conditional responses %s',
    async (etag) => {
      const response = await media('/media/img-1.jpg', ['img-1.jpg'], 'image/svg+xml', etag);
      expect(response.status).toBe(etag ? 304 : 200);
      expect(response.headers.get('content-security-policy')).toBe(SVG_CSP);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  );

  it('a cookie on the request does not make a media response private', () => {
    const request = new Request('https://shop.test/media/img-1.jpg', {
      headers: { cookie: 'session=abc' },
    });
    expect(privateResponse(request, new Response('x'))).toBe(false);
    expect(privateResponse(request, new Response('x', { headers: { 'set-cookie': 'a=b' } }))).toBe(
      true
    );
    expect(
      privateResponse(new Request('https://shop.test/products/tee', request), new Response('x'))
    ).toBe(true);
  });

  it('the exact original is immutable', async () => {
    const response = await media('/media/img-1.jpg', ['img-1.jpg']);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('a ready variant is immutable', async () => {
    const response = await media('/media/img-1.jpg?w=640', ['img-1.jpg', 'img-1.w640.jpg']);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('a ?w= fallback to the original keeps the short TTL', async () => {
    const response = await media('/media/img-1.jpg?w=640', ['img-1.jpg']);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300, must-revalidate');
  });
});

describe('L3: HSTS', () => {
  function fakeCtx(contentType = 'text/html') {
    const storefront = Object.assign(
      () => ({
        fetch: async () =>
          new Response('<html>ok</html>', {
            headers: {
              'content-type': contentType,
              ...(contentType === 'image/svg+xml' ? { 'content-security-policy': SVG_CSP } : {}),
            },
          }),
      }),
      { purgeInvalidations: async () => {} }
    );
    return { waitUntil: () => {}, exports: { PublicStorefront: storefront } };
  }
  it('preserves the restrictive SVG policy through global security headers', async () => {
    const { default: worker } = await import('../web/src/server');
    const response = await worker.fetch(
      new Request('https://shop.test/products/tee', { headers: { accept: 'text/html' } }),
      { DB: db } as never,
      fakeCtx('image/svg+xml') as never
    );
    expect(response.headers.get('content-security-policy')).toBe(SVG_CSP);
  });
  it('HTTPS responses carry Strict-Transport-Security, plain HTTP does not', async () => {
    const { default: worker } = await import('../web/src/server');
    const get = (url: string) =>
      worker.fetch(
        new Request(url, { headers: { accept: 'text/html' } }),
        { DB: db } as never,
        fakeCtx() as never
      );
    expect(
      (await get('https://shop.test/products/tee')).headers.get('strict-transport-security')
    ).toBe('max-age=31536000');
    expect(
      (await get('http://localhost/products/tee')).headers.has('strict-transport-security')
    ).toBe(false);
  });
});

describe('L4: CSRF covers /api', () => {
  async function run(request: Request, handlerType: 'router' | 'serverFn' = 'router') {
    const { csrfMiddleware } = await import('../web/src/start');
    const server = csrfMiddleware.options.server as (ctx: unknown) => Promise<unknown> | unknown;
    const result = await server({ request, handlerType, next: () => 'next' });
    return result instanceof Response ? result.status : result;
  }
  it('rejects an unsafe /api request with no Origin, Sec-Fetch-Site or Referer', async () => {
    expect(await run(new Request('https://shop.test/api/checkout', { method: 'POST' }))).toBe(403);
    expect(
      await run(
        new Request('https://shop.test/api/account', {
          method: 'DELETE',
          headers: { origin: 'https://evil.test' },
        })
      )
    ).toBe(403);
  });
  it('allows same-origin /api requests, safe methods, pages and the Stripe webhook', async () => {
    expect(
      await run(
        new Request('https://shop.test/api/checkout', {
          method: 'POST',
          headers: { origin: 'https://shop.test' },
        })
      )
    ).toBe('next');
    expect(
      await run(
        new Request('https://shop.test/api/checkout', {
          method: 'POST',
          headers: { 'sec-fetch-site': 'same-origin' },
        })
      )
    ).toBe('next');
    expect(await run(new Request('https://shop.test/api/account?export=1'))).toBe('next');
    expect(
      await run(new Request('https://shop.test/api/webhooks/stripe', { method: 'POST' }))
    ).toBe('next');
  });
  it('server functions are still checked', async () => {
    expect(
      await run(new Request('https://shop.test/_serverFn/x', { method: 'POST' }), 'serverFn')
    ).toBe(403);
  });
});

describe('M4: read permissions', () => {
  const grants: Record<string, Record<string, boolean>> = {
    'report.view': { owner: true, admin: true, manager: true, support: false, warehouse: false },
    'order.view': { owner: true, admin: true, manager: true, support: true, warehouse: true },
    'settings.view': { owner: true, admin: true, manager: false, support: false, warehouse: false },
  };
  it('the grant table matches decision 3', () => {
    for (const [permission, byRole] of Object.entries(grants)) {
      const [resource, action] = permission.split('.') as [string, string];
      for (const [role, expected] of Object.entries(byRole)) {
        const result = roles[role as keyof typeof roles].authorize({ [resource]: [action] });
        expect(result.success, `${role} ${permission}`).toBe(expected);
        const check = () =>
          requireStaffPermission({ id: 's', role } as never, resource as never, action as never);
        if (expected) expect(check).not.toThrow();
        else expect(check).toThrow();
      }
    }
  });
});

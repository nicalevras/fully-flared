import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { SITEMAP_CHUNK, sitemapChild, sitemapIndex } from '../web/src/server/sitemap';
import { publicCacheRequest, sitemapCacheResponse } from '../web/src/server/public-cache';

let db: D1Database;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => dispose());

const base = 'https://shop.example';
const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1] ?? '');

it(
  'splits products into bounded child sitemaps listed by an index',
  { timeout: 120_000 },
  async () => {
    const rows = Array.from({ length: SITEMAP_CHUNK + 1 }, (_, i) => ({
      id: `p${String(i).padStart(6, '0')}`,
      status: 'active',
    }));
    rows.push({ id: 'p999999', status: 'archived' });
    await db
      .prepare(
        `INSERT INTO products(id,slug,title,description,status,created_at,updated_at)
       SELECT json_extract(value,'$.id'), 'slug-' || json_extract(value,'$.id'), 'Product', '', json_extract(value,'$.status'), '2026-01-01', '2026-01-02' FROM json_each(?)`
      )
      .bind(JSON.stringify(rows))
      .run();
    const index = await sitemapIndex(db, base);
    expect(index).toContain('<sitemapindex');
    const children = locs(index.replaceAll('&amp;', '&'));
    const productChildren = children.filter((loc) =>
      loc.startsWith(`${base}/sitemap/products.xml`)
    );
    expect(productChildren).toHaveLength(2);
    expect(children).toContain(`${base}/sitemap/pages.xml`);
    const listed: string[] = [];
    for (const loc of productChildren) {
      const xml = await sitemapChild(db, base, 'products', new URL(loc).searchParams.get('from'));
      expect(xml).toContain('<urlset');
      const urls = locs(xml ?? '');
      expect(urls.length).toBeLessThanOrEqual(SITEMAP_CHUNK);
      listed.push(...urls);
    }
    expect(listed.sort()).toEqual(
      rows
        .filter((r) => r.status === 'active')
        .map((r) => `${base}/products/slug-${r.id}`)
        .sort()
    );
    expect(await sitemapChild(db, base, 'unknown', null)).toBeNull();
    expect(await sitemapChild(db, base, 'products', "x' OR 1=1")).toBeNull();
  }
);

it('serves sitemaps through the edge cache for XML clients with a day-long edge TTL', () => {
  const request = new Request(`${base}/sitemap.xml?utm_source=x`, {
    headers: { accept: 'application/xml' },
  });
  expect(publicCacheRequest(request)?.url).toBe(`${base}/sitemap.xml`);
  const child = new Request(`${base}/sitemap/products.xml?from=p000001`, {
    headers: { accept: 'text/xml' },
  });
  expect(publicCacheRequest(child)?.url).toBe(`${base}/sitemap/products.xml?from=p000001`);
  const response = sitemapCacheResponse(
    new Response('<urlset/>', { headers: { 'Content-Type': 'application/xml' } })
  );
  expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
  expect(response.headers.get('CDN-Cache-Control')).toBe('max-age=86400');
  expect(response.headers.has('Cache-Tag')).toBe(false);
  expect(
    sitemapCacheResponse(new Response('Not found', { status: 404 })).headers.get('Cache-Control')
  ).toBe('private, no-store');
});

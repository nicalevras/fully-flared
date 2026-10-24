import { getStorefrontLayout, type CatalogKv } from './catalog-read';

/** The canonical base comes from the published layout, so serving robots.txt needs no D1 read. */
export async function robotsTxt(
  db: D1Database,
  env: { CATALOG_KV?: CatalogKv },
  origin: string
): Promise<Response> {
  const base = (await getStorefrontLayout(db, env)).canonicalBaseUrl || origin;
  return new Response(
    `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /account\nDisallow: /cart\nDisallow: /checkout\nDisallow: /auth\nDisallow: /api\nSitemap: ${base}/sitemap.xml\n`,
    { headers: { 'Content-Type': 'text/plain' } }
  );
}

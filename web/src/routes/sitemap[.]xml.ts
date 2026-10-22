import { createFileRoute } from '@tanstack/react-router';
import { getSettings } from '../server/settings';

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        const settings = await getSettings(env.DB);
        const base = settings.canonicalBaseUrl || new URL(request.url).origin;
        const [products, collections, posts, pages] = await Promise.all([
          env.DB.prepare(`SELECT slug, updated_at FROM products WHERE status = 'active'`).all<{
            slug: string;
            updated_at: string;
          }>(),
          env.DB.prepare('SELECT slug FROM collections').all<{ slug: string }>(),
          env.DB.prepare(
            `SELECT slug, published_at FROM posts WHERE (status = 'published' AND (published_at IS NULL OR datetime(published_at) <= datetime('now'))) OR (status = 'scheduled' AND published_at IS NOT NULL AND datetime(published_at) <= datetime('now'))`
          ).all<{ slug: string; published_at: string }>(),
          env.DB.prepare('SELECT slug FROM pages').all<{ slug: string }>(),
        ]);
        const urls: { loc: string; lastmod?: string }[] = [
          { loc: `${base}/` },
          { loc: `${base}/blog` },
          ...products.results.map((p) => ({
            loc: `${base}/products/${p.slug}`,
            lastmod: p.updated_at?.slice(0, 10),
          })),
          ...collections.results.map((c) => ({ loc: `${base}/collections/${c.slug}` })),
          ...posts.results.map((p) => ({
            loc: `${base}/blog/${p.slug}`,
            lastmod: p.published_at?.slice(0, 10),
          })),
          ...pages.results.map((p) => ({ loc: `${base}/pages/${p.slug}` })),
        ];
        const escXml = (s: string) =>
          s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
          .map(
            (u) =>
              `  <url><loc>${escXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`
          )
          .join('\n')}\n</urlset>`;
        return new Response(xml, {
          headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=3600' },
        });
      },
    },
  },
});

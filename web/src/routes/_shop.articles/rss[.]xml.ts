import { createFileRoute } from '@tanstack/react-router';
import { getSettings } from '../../server/settings';

function xmlEscape(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const Route = createFileRoute('/_shop/articles/rss.xml')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        const settings = await getSettings(env.DB);
        const origin = settings.canonicalBaseUrl || new URL(request.url).origin;
        const posts = await env.DB.prepare(
          `SELECT slug, title, excerpt, published_at FROM posts
           WHERE (status = 'published' AND (published_at IS NULL OR datetime(published_at) <= datetime('now'))) OR (status = 'scheduled' AND published_at IS NOT NULL AND datetime(published_at) <= datetime('now'))
           ORDER BY published_at DESC LIMIT 50`
        ).all<{ slug: string; title: string; excerpt: string; published_at: string | null }>();
        const items = posts.results
          .map(
            (p) => `    <item>
      <title>${xmlEscape(p.title)}</title>
      <link>${origin}/articles/${p.slug}</link>
      <guid isPermaLink="true">${origin}/articles/${p.slug}</guid>
      <description>${xmlEscape(p.excerpt)}</description>
      ${p.published_at ? `<pubDate>${new Date(p.published_at).toUTCString()}</pubDate>` : ''}
    </item>`
          )
          .join('\n');
        const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEscape(settings.storeName)}</title>
    <link>${origin}/articles</link>
    <description>${xmlEscape(settings.storeName)} articles</description>
${items}
  </channel>
</rss>`;
        return new Response(body, {
          headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
        });
      },
    },
  },
});

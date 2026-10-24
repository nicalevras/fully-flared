import { createFileRoute } from '@tanstack/react-router';
import { getSettings } from '../server/settings';
import { sitemapChild, sitemapResponse } from '../server/sitemap';

export const Route = createFileRoute('/sitemap/{$kind}.xml')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { env } = await import('cloudflare:workers');
        const url = new URL(request.url);
        const settings = await getSettings(env.DB);
        const base = settings.canonicalBaseUrl || url.origin;
        const xml = await sitemapChild(env.DB, base, params.kind, url.searchParams.get('from'));
        return xml === null ? new Response('Not found', { status: 404 }) : sitemapResponse(xml);
      },
    },
  },
});

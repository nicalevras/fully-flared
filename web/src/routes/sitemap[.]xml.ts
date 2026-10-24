import { createFileRoute } from '@tanstack/react-router';
import { getSettings } from '../server/settings';
import { sitemapIndex, sitemapResponse } from '../server/sitemap';

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        const settings = await getSettings(env.DB);
        const base = settings.canonicalBaseUrl || new URL(request.url).origin;
        return sitemapResponse(await sitemapIndex(env.DB, base));
      },
    },
  },
});

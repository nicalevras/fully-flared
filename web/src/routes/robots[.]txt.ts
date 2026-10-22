import { createFileRoute } from '@tanstack/react-router';
import { getSettings } from '../server/settings';

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        const settings = await getSettings(env.DB);
        const base = settings.canonicalBaseUrl || new URL(request.url).origin;
        return new Response(
          `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /account\nDisallow: /cart\nDisallow: /checkout\nDisallow: /auth\nDisallow: /api\nSitemap: ${base}/sitemap.xml\n`,
          {
            headers: { 'Content-Type': 'text/plain' },
          }
        );
      },
    },
  },
});

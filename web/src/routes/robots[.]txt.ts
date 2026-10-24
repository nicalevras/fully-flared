import { createFileRoute } from '@tanstack/react-router';
import { robotsTxt } from '../server/robots';

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        return robotsTxt(env.DB, env, new URL(request.url).origin);
      },
    },
  },
});

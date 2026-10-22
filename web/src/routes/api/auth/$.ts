import { createFileRoute } from '@tanstack/react-router';
import { getRequestAuth } from '../../../server/session';

async function handle(request: Request) {
  const { env } = await import('cloudflare:workers');
  const auth = await getRequestAuth(env.DB, request);
  return auth.handler(request);
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});

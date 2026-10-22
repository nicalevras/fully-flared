import { createFileRoute } from '@tanstack/react-router';
import {
  guestCapabilityCookieHeader,
  parseGuestCapability,
} from '../../../server/checkout-intents';
import { getSessionUser } from '../../../server/session';

// Guest bootstrap (Round 2): establishes the HttpOnly guest capability
// cookie BEFORE any commerce state exists, so a lost checkout response
// can never strand an intent its owner cannot prove. Bootstrap creates
// no intent and no D1 commerce record; the capability hash is bound
// only when a checkout is actually created. An existing valid
// capability is reused as-is (204, no Set-Cookie) — bootstrap retries,
// reloads and second tabs must never rotate ownership. Only an absent
// capability mints a fresh one.
export const Route = createFileRoute('/api/checkout/guest-session')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        return handleGuestBootstrapRequest(request, env);
      },
    },
  },
});

export async function handleGuestBootstrapRequest(
  request: Request,
  env: { DB: D1Database }
): Promise<Response> {
  const sessionUser = await getSessionUser(env.DB, request).catch(() => null);
  if (sessionUser) return new Response(null, { status: 204 });
  if (parseGuestCapability(request.headers.get('cookie')))
    return new Response(null, { status: 204 });
  const secure = new URL(request.url).protocol === 'https:';
  return new Response(null, {
    status: 204,
    headers: {
      'Set-Cookie': guestCapabilityCookieHeader(crypto.randomUUID(), secure),
    },
  });
}

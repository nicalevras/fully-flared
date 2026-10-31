import { createFileRoute } from '@tanstack/react-router';
import { AuthError, getSessionUser } from '../../server/session';

// Customer self-service API (plan Step 5): address book, data export,
// account deletion. Every handler requires the caller's own session; a
// customer can only ever touch their own rows.
async function requireUser(request: Request) {
  const { env } = await import('cloudflare:workers');
  const user = await getSessionUser(env.DB, request);
  if (!user) throw new AuthError('UNAUTHENTICATED', 'Sign in required');
  return { env, user };
}

export const Route = createFileRoute('/api/account')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { env, user } = await requireUser(request);
          const url = new URL(request.url);
          if (url.searchParams.get('export') === '1') {
            return Response.json(
              {
                ok: false,
                error: 'Use the export button in your account to download your complete history.',
              },
              { status: 410, headers: { 'Cache-Control': 'private, no-store' } }
            );
          }
          const rows = await env.DB.prepare(
            'SELECT id, name, line1, line2, city, state AS region, postal_code, country, phone, is_default FROM addresses WHERE user_id = ? ORDER BY is_default DESC, rowid'
          )
            .bind(user.id)
            .all();
          return Response.json({ ok: true, addresses: rows.results });
        } catch (err) {
          if (err instanceof AuthError && err.code === 'UNAUTHENTICATED') {
            return Response.json({ ok: false, error: 'Sign in required' }, { status: 401 });
          }
          console.error(
            JSON.stringify({
              event: 'account_api_failed',
              error: err instanceof Error ? err.message : 'unknown',
            })
          );
          return Response.json({ ok: false, error: 'Something went wrong' }, { status: 500 });
        }
      },
    },
  },
});

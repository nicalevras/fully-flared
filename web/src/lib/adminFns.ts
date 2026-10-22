import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseStatus } from '@tanstack/react-start/server';
import * as z from 'zod';
import { staffMiddleware } from '../server/staff-middleware';
import { runAdminAction } from '../server/admin-actions';
import { getRequestAuth } from '../server/session';

const actionInputSchema = z.object({
  action: z.string().min(1).max(100),
  payload: z.record(z.string(), z.json()),
});

/**
 * The one admin mutation entry point (replaces the /api/admin JSON route):
 * staffMiddleware authenticates and passes the typed staff context, the
 * Zod union in runAdminAction validates per-action payloads, and catalog
 * invalidation is enqueued exactly as the route did.
 */
export const adminActionFn = createServerFn({ method: 'POST' })
  .middleware([staffMiddleware])
  .validator((input: z.input<typeof actionInputSchema>) => {
    const parsed = actionInputSchema.safeParse(input);
    if (!parsed.success) {
      setResponseStatus(400);
      throw new Error('Invalid action input');
    }
    return parsed.data;
  })
  .handler(async ({ data, context }) => {
    const { env } = await import('cloudflare:workers');
    const request = getRequest();
    const actor = { id: context.staff.id, role: context.staff.role ?? 'customer' };
    const auth = await getRequestAuth(env.DB, request);
    const result = await runAdminAction(
      env.DB,
      env,
      actor,
      data.action,
      data.payload,
      { auth, headers: request.headers },
      new URL(request.url).origin
    );
    if (!result.ok) setResponseStatus(result.status ?? 400);
    // Catalog change capture is durable and transactional (migration
    // 0004 triggers write catalog_work rows with the edit itself), so
    // correctness no longer depends on this action-name heuristic. Any
    // successful mutation enqueues a cheap wake-up; the consumer
    // processes due work and no-ops when nothing is outstanding. The
    // cron sweep covers a lost wake-up.
    if (result.ok) {
      const { enqueueCatalogRebuild } = await import('../server/catalog-publisher');
      await enqueueCatalogRebuild(env);
    }
    return result;
  });

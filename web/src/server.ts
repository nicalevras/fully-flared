import {
  privateResponse,
  publicCacheRequest,
  drainCatalogInvalidations,
} from './server/public-cache';
import { normalizeNetwork } from './server/network';
import entry from '@tanstack/react-start/server-entry';
import {
  drainOutbox,
  processOutboxRow,
  emailStatement,
  operationalRecipients,
  commitWithEmails,
  type JobMessage,
} from './server/email';
import { releaseExpiredReservations } from './server/inventory';
import {
  cancelExpiredPendingOrders,
  failInboxEvent,
  processInboxEvent,
  reconcileLateRefunds,
  reprocessStaleInbox,
} from './server/checkout';
import { getStripeProvider } from './server/payments';
import { queueAbandonedReminder } from './server/email';
import { reconcileStripe } from './server/reconcile';
import { pruneRetention } from './server/operations';
import { runCatalogUnit } from './server/catalog-publisher';
import { CatalogBudget, countedDb } from './server/catalog-exec';
import { requireStaff } from './server/session';
import { runWithRequestContext } from './server/exec-context';
import { jobMessageSchema } from './schemas/queue';

export { RealtimeDO } from './do/realtime';
export { CheckoutAdmissionDO } from './do/checkout-admission';
export { PublicStorefront } from './server/public-storefront';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://challenges.cloudflare.com https://js.stripe.com https://api.stripe.com",
  'frame-src https://challenges.cloudflare.com https://js.stripe.com https://hooks.stripe.com',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://checkout.stripe.com",
  "frame-ancestors 'none'",
].join('; ');

function withSecurityHeaders(response: Response, request?: Request): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  if (request) {
    if (privateResponse(request, response)) {
      headers.set('Cache-Control', 'private, no-store');
      headers.set('CDN-Cache-Control', 'no-store');
      headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
    }
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Abuse protection: Cloudflare's platform rate limiter only. There is no
// per-isolate in-memory fallback â€” an isolate-local Map cannot limit an
// attacker who spreads across isolates, and silently pretending otherwise
// is worse than no limiter. Keys prefer the session cookie (per-visitor)
// over the client IP, per Cloudflare's guidance that IP keys are not
// recommended on their own; Turnstile gates checkout/auth on top.
async function rateLimit(
  request: Request,
  env: Cloudflare.Env,
  url: URL
): Promise<Response | null> {
  const isCheckout = url.pathname === '/api/checkout' && request.method === 'POST';
  const isAuth = url.pathname.startsWith('/api/auth/') && request.method === 'POST';
  // Discount validation moved to a server function (validateDiscountFn),
  // which enforces AUTH_LIMITER itself; there is no HTTP route to match.
  if (!isCheckout && !isAuth) return null;
  const binding = isCheckout ? env.CHECKOUT_LIMITER : env.AUTH_LIMITER;
  if (!binding) {
    // Fail closed on the abuse-sensitive endpoints: no limiter configured
    // means no checkout/auth traffic, not unlimited traffic.
    return Response.json(
      { ok: false, error: 'This store is temporarily unavailable. Please try again later.' },
      { status: 503, headers: { 'Retry-After': '60' } }
    );
  }
  const cookie = request.headers.get('cookie') ?? '';
  const sessionMatch = cookie.match(/better-auth\.session_token=([^;]+)/);
  const ip = normalizeNetwork(request.headers.get('CF-Connecting-IP') ?? 'unknown');
  // A cookie value is only an identity if it names a real session row;
  // otherwise anyone could mint fresh buckets by rotating a fake cookie.
  let identity = `ip:${ip}`;
  const rawToken = sessionMatch?.[1];
  if (rawToken) {
    // A malformed % escape must not 500 the request: fall back to the IP
    // identity below (B12).
    let decoded = rawToken;
    try {
      decoded = decodeURIComponent(rawToken);
    } catch {
      decoded = rawToken;
    }
    const token = decoded.split('.')[0] ?? '';
    if (token) {
      const sessionRow = await env.DB.prepare('SELECT id FROM session WHERE token = ?')
        .bind(token)
        .first<{ id: string }>()
        .catch(() => null);
      if (sessionRow) identity = `s:${token.slice(0, 32)}`;
    }
  }
  const key = `${url.pathname}:${identity}`;
  let result: { success: boolean };
  try {
    result = await binding.limit({ key });
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'rate_limit_unavailable', path: url.pathname, error: String(error) })
    );
    return Response.json({ error: 'Service temporarily unavailable' }, { status: 503 });
  }
  if (result.success) return null;
  return Response.json(
    { ok: false, error: 'Too many requests. Please wait a minute and try again.' },
    { status: 429, headers: { 'Retry-After': '60' } }
  );
}

async function sendAbandonedReminders(db: D1Database): Promise<number> {
  // Orders whose configured hold expired unpaid get one "still want it?" email.
  const rows = await db
    .prepare(
      `SELECT id, number, customer_email FROM orders
       WHERE status = 'canceled' AND payment_status = 'unpaid'
         AND abandoned_reminded_at IS NULL
         AND updated_at > datetime('now', '-48 hours')
       ORDER BY updated_at LIMIT 10`
    )
    .all<{ id: string; number: string; customer_email: string }>();
  let sent = 0;
  for (const order of rows.results) {
    if (await queueAbandonedReminder(db, order)) sent++;
  }
  return sent;
}

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    // Better Auth background tasks reach ctx.waitUntil through this storage
    // (advanced.backgroundTasks.handler in lib/auth.ts).
    return runWithRequestContext(ctx, () => handleFetch(request, env, ctx));
  },

  async queue(
    batch: MessageBatch<unknown>,
    env: Cloudflare.Env,
    ctx: ExecutionContext
  ): Promise<void> {
    return handleQueue(batch as MessageBatch<JobMessage>, env, ctx);
  },

  async scheduled(
    controller: ScheduledController,
    env: Cloudflare.Env,
    ctx: ExecutionContext
  ): Promise<void> {
    return handleScheduled(controller, env, ctx);
  },
};

/** Purges pending catalog invalidations through the cache-owning
 *  entrypoint (purges are scoped to it). Failed purges keep their
 *  rows pending; the 60 s cache TTL remains the fallback. */
async function drainPublicCacheInvalidations(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  budget?: CatalogBudget
): Promise<void> {
  await drainCatalogInvalidations(
    budget ? countedDb(env.DB, budget) : env.DB,
    async (tags) => {
      budget?.tickOp();
      return ctx.exports.PublicStorefront.purgeInvalidations(tags);
    },
    budget ? 90 : 500
  );
}

async function handleFetch(
  request: Request,
  env: Cloudflare.Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/ws') {
    if (request.headers.get('origin') !== url.origin)
      return new Response('Origin refused', { status: 403 });
    // Admin realtime stream: staff sessions that passed 2FA only.
    try {
      await requireStaff(env.DB, request);
    } catch {
      return new Response('Staff access required', { status: 403 });
    }
    const stub = env.REALTIME.getByName('admin');
    return stub.fetch(request);
  }
  // CSRF: state-changing browser requests must be same-origin. Better Auth
  // also checks Origin for its own routes; this covers the store's APIs.
  // The Stripe webhook is server-to-server and carries no Origin.
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
    url.pathname !== '/api/webhooks/stripe'
  ) {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) {
      return withSecurityHeaders(
        Response.json({ ok: false, error: 'Cross-origin request refused' }, { status: 403 }),
        request
      );
    }
  }
  const limited = await rateLimit(request, env, url);
  if (limited) return withSecurityHeaders(limited, request);
  // Only classified public HTML GETs render in the cache-owning
  // PublicStorefront entrypoint, with private headers stripped and
  // the store identity carried in ctx.props (the Workers Cache key
  // excludes hostname, so props provide the partitioning). Everything
  // else renders here in the uncached gateway.
  const forwarded = publicCacheRequest(request);
  let response: Response;
  if (forwarded) {
    try {
      response = await ctx.exports
        .PublicStorefront({ props: { store: url.hostname.toLowerCase() } })
        .fetch(forwarded);
    } catch (error) {
      // A storefront failure must not take the page down with it:
      // render directly in the gateway, as the retired Cache API
      // wrapper did when the cache was unavailable.
      console.error(JSON.stringify({ event: 'public_storefront_failed', error: String(error) }));
      response = await entry.fetch(forwarded);
    }
  } else {
    response = await entry.fetch(request);
  }
  return withSecurityHeaders(response, forwarded ?? request);
}

async function handleQueue(
  batch: MessageBatch<JobMessage>,
  env: Cloudflare.Env,
  ctx: ExecutionContext
): Promise<void> {
  const isDlq = batch.queue.includes('dlq');
  for (const message of batch.messages) {
    const parsedJob = jobMessageSchema.safeParse(message.body);
    if (!parsedJob.success) {
      console.error(JSON.stringify({ queue: batch.queue, error: 'invalid job message' }));
      message.ack();
      continue;
    }
    const job = parsedJob.data;
    if (isDlq) {
      // Dead-lettered webhooks are parked as 'dead': the operator email
      // fires once (in failInboxEvent) and the cron sweep
      // (reprocessStaleInbox) retries them after a fixed 6-hour delay, so a
      // dead-lettered event is delayed, never lost.
      if (job.type === 'webhook.process') {
        await failInboxEvent(env.DB, job.eventId, true);
      }
      console.error(JSON.stringify({ alert: 'dlq', queue: batch.queue, job: job.type }));
      message.ack();
      continue;
    }
    try {
      if (job.type === 'email.send') {
        await processOutboxRow(env.DB, job.outboxId);
      } else if (job.type === 'webhook.process') {
        await processInboxEvent(env.DB, job.eventId, getStripeProvider(env) ?? undefined);
      } else if (job.type === 'catalog.rebuild') {
        // Bounded catalog execution (Round 2): exactly one unit per
        // invocation under the shared budget. The budget covers the
        // unit plus this handler's follow-up (invalidation drain and
        // realtime broadcast); when it is nearly spent the follow-up
        // is deferred — invalidations stay queued for the next unit.
        const budget = new CatalogBudget();
        const result = await runCatalogUnit(env.DB, env.CATALOG_KV, { budget });
        if (budget.remaining > 10 && budget.remainingStatements > 5) {
          await drainPublicCacheInvalidations(env, ctx, budget);
          budget.tickOp();
          const stub = env.REALTIME.getByName('admin');
          await stub
            .broadcast('catalog.rebuilt', result)
            .catch((error) =>
              console.error(
                JSON.stringify({ event: 'realtime_broadcast_failed', error: String(error) })
              )
            );
        }
        if (!result.done) {
          // Enqueue the continuation BEFORE acking. If the send
          // fails, throw so this message retries; durable progress
          // already made stays recoverable.
          try {
            budget.tickOp();
            await env.CATALOG_JOBS.send({ type: 'catalog.rebuild' });
          } catch (sendError) {
            console.error(
              JSON.stringify({
                event: 'catalog_continuation_enqueue_failed',
                error: String(sendError),
              })
            );
            throw sendError;
          }
        }
      }
      message.ack();
    } catch (err) {
      console.error(
        JSON.stringify({
          queue: batch.queue,
          job: job.type,
          error: err instanceof Error ? err.message : 'failed',
        })
      );
      message.retry({ delaySeconds: 30 });
    }
  }
}

async function handleScheduled(
  _event: ScheduledController,
  env: Cloudflare.Env,
  ctx: ExecutionContext
): Promise<void> {
  ctx.waitUntil(
    (async () => {
      // Each maintenance task is independent: one failure is logged and
      // counted, never allowed to starve the rest of the sweep.
      const provider = getStripeProvider(env);
      const tasks: Array<[string, () => Promise<unknown>]> = [
        ['releaseExpiredReservations', () => releaseExpiredReservations(env.DB, 100)],
        ['cancelExpiredPendingOrders', () => cancelExpiredPendingOrders(env.DB, 100)],
        ['reprocessStaleInbox', () => reprocessStaleInbox(env.DB, provider, 20)],
        [
          'reconcileCheckoutIntents',
          async () => {
            const { reconcileCheckoutIntents } = await import('./server/checkout-intents');
            return reconcileCheckoutIntents(env.DB, provider, 20, env.CHECKOUT_ADMISSION);
          },
        ],
        ['drainOutbox', () => drainOutbox(env.DB, 25)],
        ['reconcileLateRefunds', () => reconcileLateRefunds(env.DB, provider ?? undefined)],
        ['abandonedReminders', () => sendAbandonedReminders(env.DB)],
        // Cron only enqueues a wake-up; publication runs solely in
        // the queue consumer (Round 2: no direct cron publishing).
        [
          'catalogWork',
          async () => {
            await env.CATALOG_JOBS.send({ type: 'catalog.rebuild' });
            return { enqueued: true };
          },
        ],
        // Backstop purge drain: queue jobs drain promptly after each
        // publish; this keeps invalidations moving if a wake-up was lost.
        ['catalogInvalidations', () => drainPublicCacheInvalidations(env, ctx)],
        [
          'reconcileStripe',
          async () => {
            if (!provider) return { skipped: 'stripe-not-configured' };
            const report = await reconcileStripe(env.DB, provider);
            if (report.mismatches.length > 0) {
              console.error(
                JSON.stringify({
                  alert: 'reconciliation_mismatch',
                  count: report.mismatches.length,
                  mismatches: report.mismatches.slice(0, 20),
                })
              );
              const recipients = await operationalRecipients(env.DB);
              if (recipients.length)
                await commitWithEmails(
                  env.DB,
                  recipients.map((to) =>
                    emailStatement(
                      env.DB,
                      `reconcile-${new Date().toISOString().slice(0, 10)}-${to}`,
                      {
                        to,
                        subject: `Reconciliation found ${report.mismatches.length} mismatches`,
                        text: 'Check Workers Logs for reconciliation_mismatch details.',
                        html: '<p>Check Workers Logs for reconciliation_mismatch details.</p>',
                      }
                    )
                  ),
                  recipients.map((to) => `reconcile-${new Date().toISOString().slice(0, 10)}-${to}`)
                );
            }
            return report;
          },
        ],
        ['pruneRetention', () => pruneRetention(env.DB)],
      ];
      // Serialized: tasks share one D1 budget, so running them in
      // parallel only moves contention into statement latency. Each
      // task keeps its own failure isolation and summary entry.
      const summary: Record<string, unknown> = { cron: 'maintenance' };
      for (const [name, run] of tasks) {
        try {
          summary[name] = await run();
        } catch (error) {
          summary[name] = 'failed';
          console.error(
            JSON.stringify({
              cron_task_failed: name,
              error: error instanceof Error ? error.message : 'unknown',
            })
          );
        }
      }
      // Catalog backlog observability: pending change-capture rows and
      // the age of the oldest one, so a stalled publisher is visible in
      // Workers Logs before shoppers notice stale pages.
      try {
        const backlog = await env.DB.prepare(
          'SELECT COUNT(*) AS n, MIN(updated_at) AS oldest FROM catalog_work WHERE processed_revision < target_revision'
        ).first<{ n: number; oldest: string | null }>();
        console.log(
          JSON.stringify({
            event: 'catalog_backlog',
            pending: backlog?.n ?? 0,
            oldestAgeSeconds: backlog?.oldest
              ? Math.max(0, Math.round((Date.now() - Date.parse(backlog.oldest)) / 1000))
              : null,
          })
        );
      } catch {
        console.warn(JSON.stringify({ event: 'catalog_backlog_unavailable' }));
      }
      console.log(JSON.stringify(summary));
    })()
  );
}

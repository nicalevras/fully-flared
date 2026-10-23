import {
  privateResponse,
  publicCacheRequest,
  drainCatalogInvalidations,
} from './server/public-cache';
import { normalizeNetwork } from './server/network';
import entry from '@tanstack/react-start/server-entry';
import { processOutboxRow, type JobMessage } from './server/email';
import { failInboxEvent, processInboxEvent } from './server/checkout';
import { getStripeProvider, providerWithBudget } from './server/payments';
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

const CRON_DRAIN_PASSES = 3;

/** Purges pending catalog invalidations through the cache-owning
 *  entrypoint (purges are scoped to it). Failed purges keep their
 *  rows pending; the 60 s cache TTL remains the fallback. A budgeted
 *  queue drain takes one pass; the cron drain continues while a full
 *  page was purged, bounded to stay within one invocation's statements. */
async function drainPublicCacheInvalidations(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  budget?: CatalogBudget
): Promise<void> {
  const db = budget ? countedDb(env.DB, budget) : env.DB;
  const purge = async (tags: string[]) => {
    budget?.tickOp();
    return ctx.exports.PublicStorefront.purgeInvalidations(tags);
  };
  for (let pass = 0; pass < (budget ? 1 : CRON_DRAIN_PASSES); pass++)
    if (!(await drainCatalogInvalidations(db, purge, budget ? 90 : 500)).more) return;
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
  const isDlq = batch.queue === env.QUEUE_NAMES.DLQ;
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
      let binding: 'JOBS' | 'NOTIFICATIONS' | 'CATALOG_JOBS';
      if (job.type === 'maintenance.run') {
        const run = await env.DB.prepare('SELECT task FROM maintenance_runs WHERE id=?')
          .bind(job.runId)
          .first<{ task: string }>();
        if (!run) {
          message.ack();
          continue;
        }
        const { maintenanceQueueBinding } = await import('./server/maintenance');
        binding = maintenanceQueueBinding(run.task);
      } else {
        binding =
          job.type === 'email.send'
            ? 'NOTIFICATIONS'
            : job.type === 'catalog.rebuild'
              ? 'CATALOG_JOBS'
              : 'JOBS';
      }
      if (batch.queue !== env.QUEUE_NAMES[binding]) {
        await env[binding].send(job);
        console.warn(JSON.stringify({ event: 'queue_message_redirected', job: job.type, binding }));
        message.ack();
        continue;
      }
      if (job.type === 'email.send') {
        await processOutboxRow(env.DB, job.outboxId);
      } else if (job.type === 'webhook.process') {
        const provider = getStripeProvider(env);
        await processInboxEvent(
          env.DB,
          job.eventId,
          provider ? providerWithBudget(provider, Date.now() + 30_000, async () => {}) : undefined
        );
      } else if (job.type === 'checkout.recover') {
        const provider = getStripeProvider(env);
        if (!provider) throw Error('Payment provider unavailable');
        const deadline = Date.now() + 30_000;
        const { runAuthorizedCheckout } = await import('./server/authorized-checkout');
        await runAuthorizedCheckout(
          env.DB,
          providerWithBudget(provider, deadline, async () => {}),
          job.intentId,
          env.CHECKOUT_ADMISSION,
          deadline
        );
      } else if (job.type === 'maintenance.run') {
        const { runMaintenance } = await import('./server/maintenance');
        await runMaintenance(env, job.runId);
      } else if (job.type === 'catalog.rebuild') {
        // Bounded catalog execution (Round 2): exactly one unit per
        // invocation under the shared budget. The budget covers the
        // unit plus this handler's follow-up (invalidation drain and
        // realtime broadcast); when it is nearly spent the follow-up
        // is deferred — invalidations stay queued for the next unit.
        // Purges wait for the finished run so a multi-unit publish
        // spends one rate-limited request instead of one per unit.
        const budget = new CatalogBudget();
        const result = await runCatalogUnit(env.DB, env.CATALOG_KV, { budget });
        if (budget.remaining > 10 && budget.remainingStatements > 5) {
          if (result.done) await drainPublicCacheInvalidations(env, ctx, budget);
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
            await env.CATALOG_JOBS.send(
              { type: 'catalog.rebuild' },
              result.retryAfterSeconds ? { delaySeconds: result.retryAfterSeconds } : undefined
            );
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
  event: ScheduledController,
  env: Cloudflare.Env,
  ctx: ExecutionContext
): Promise<void> {
  ctx.waitUntil(
    (async () => {
      const { startMaintenance, wakeDueMaintenance } = await import('./server/maintenance');
      const { catalogWorkDue } = await import('./server/catalog-operations');
      const date = new Date(event.scheduledTime),
        day = date.toISOString().slice(0, 10),
        hour = date.toISOString().slice(0, 13);
      const work: { name: string; promise: Promise<unknown> }[] = [];
      if (event.cron === '0 3 * * *') {
        for (const task of ['reconciliation', 'retention', 'reminders', 'replica', 'gc'] as const)
          work.push({
            name: task,
            promise: startMaintenance(env, task, day).then((ok) => {
              if (!ok) throw Error('Maintenance enqueue failed');
            }),
          });
      } else if (event.cron === '7 * * * *')
        work.push({
          name: 'privacy',
          promise: startMaintenance(env, 'privacy', hour).then((ok) => {
            if (!ok) throw Error('Maintenance enqueue failed');
          }),
        });
      else {
        work.push({
          name: 'recovery-watchdog',
          promise: wakeDueMaintenance(env).then(({ failed }) => {
            if (failed) throw Error('Recovery watchdog dispatch incomplete');
          }),
        });
        work.push({
          name: 'catalog-watchdog',
          promise: (async () => {
            if (await catalogWorkDue(env.DB))
              await env.CATALOG_JOBS.send({ type: 'catalog.rebuild' });
          })(),
        });
      }
      work.push({ name: 'cache-invalidation', promise: drainPublicCacheInvalidations(env, ctx) });
      const results = await Promise.allSettled(work.map((task) => task.promise));
      let failed = 0;
      for (let index = 0; index < results.length; index++)
        if (results[index]!.status === 'rejected') {
          failed++;
          console.error(
            JSON.stringify({ event: 'scheduled_task_failed', task: work[index]!.name })
          );
        }
      if (failed) throw Error('One or more scheduled responsibilities failed');
    })()
  );
}

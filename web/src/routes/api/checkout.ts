import { createFileRoute } from '@tanstack/react-router';
import {
  createOrderAccessToken,
  createPendingOrder,
  quoteOrder,
  CheckoutError,
  type CheckoutIntentInsert,
} from '../../server/checkout';
import { getStripeProvider, type PaymentProvider } from '../../server/payments';
import { getSettings } from '../../server/settings';
import {
  cartCountCookieHeader,
  cartIdentity,
  clearCart as convertCart,
  clearCartCookieHeader,
  parseCartCookie,
} from '../../server/cart';
import { getSessionUser } from '../../server/session';
import { InsufficientStock } from '../../server/inventory';
import { parseJsonBody } from '../../schemas/common';
import { checkoutBodySchema } from '../../schemas/checkout';
import { prepareReview } from '../../server/authorized-checkout';
import { sha256Hex } from '../../lib/hash';
import {
  checkoutFingerprint,
  intentOwnedBy,
  loadIntent,
  parseGuestCapability,
  runIntentOperation,
  type CheckoutIntentRow,
} from '../../server/checkout-intents';
import { acquireCheckoutPermit } from '../../server/checkout-admission';
import type { WorkerEnv } from '../../server/env';

// This route intentionally stays a raw server route, like media upload
// and the Stripe webhook: server.ts keys the Cloudflare rate limiter and
// Turnstile gate on the literal /api/checkout path, and the handler
// ends in an external redirect to Stripe Checkout. All other internal
// JSON endpoints have moved to server functions (adminFns/shopFns).
export const Route = createFileRoute('/api/checkout')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        return handleCheckoutRequest(request, env);
      },
    },
  },
});

const generic = (error: string, code: string, status: number) =>
  Response.json({ error, code }, { status });

export async function handleCheckoutRequest(
  request: Request,
  env: WorkerEnv,
  options?: { deadlineMs?: number }
): Promise<Response> {
  try {
    return await prepareCheckoutRequest(request, env, options);
  } catch (error) {
    if (error instanceof CheckoutError) return generic(error.message, error.code, error.status);
    if (error instanceof InsufficientStock)
      return generic('Some items are no longer available', 'STOCK', 409);
    console.error(
      JSON.stringify({
        event: 'checkout_prepare_failed',
        error: error instanceof Error ? error.name : 'unknown',
      })
    );
    return generic('Checkout could not be prepared. Please retry.', 'INTERNAL', 500);
  }
}

async function prepareCheckoutRequest(
  request: Request,
  env: WorkerEnv,
  options?: { deadlineMs?: number }
): Promise<Response> {
  const provider = getStripeProvider(env);
  if (!provider) return generic('Payment configuration unavailable', 'DEPENDENCY', 503);
  const parsed = await parseJsonBody(request, checkoutBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!body.shippingAddress || body.shippingAddress.country !== body.shippingCountry)
    return generic('Enter a complete shipping address for the selected country', 'VALIDATION', 400);

  // A signed-in customer's orders are theirs by user_id; guests check
  // out with email only and claim orders after email verification.
  const sessionUser = await getSessionUser(env.DB, request).catch(() => null);
  const guestToken = parseGuestCapability(request.headers.get('cookie'));
  const fingerprint = await checkoutFingerprint(body);
  const secure = new URL(request.url).protocol === 'https:';

  const existing = await loadIntent(env.DB, body.intentId);
  const cartCreds = parseCartCookie(request.headers.get('cookie'));
  const cart = await cartIdentity(env.DB, cartCreds);
  const completedRetry =
    !cart &&
    existing?.cart_id === body.cartId &&
    existing.cart_revision === body.cartRevision &&
    existing.fingerprint === fingerprint &&
    (await intentOwnedBy(existing, { userId: sessionUser?.id ?? null, guestToken })) &&
    Boolean(
      await env.DB.prepare("SELECT 1 FROM orders WHERE id=? AND payment_status='paid'")
        .bind(existing.order_id)
        .first()
    );
  if ((!cart || cart.id !== body.cartId || cart.revision !== body.cartRevision) && !completedRetry)
    return generic(
      'Your cart changed. Reload it and review your order again.',
      'STALE_ATTEMPT',
      409
    );
  if (existing) {
    if (existing.cart_id !== body.cartId || existing.cart_revision !== body.cartRevision)
      return generic(
        'This checkout belongs to an older cart. Review your order again.',
        'STALE_ATTEMPT',
        409
      );
    return respondForIntent(
      env.DB,
      provider,
      request,
      existing,
      {
        userId: sessionUser?.id ?? null,
        guestToken,
        fingerprint,
        secure,
        accessSecret: env.BETTER_AUTH_SECRET ?? '',
      },
      {
        admission: env.CHECKOUT_ADMISSION,
        ...(options?.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
      }
    );
  }

  // Guests must establish ownership before any commerce state exists:
  // the HttpOnly capability cookie is minted only by the bootstrap
  // endpoint (POST /api/checkout/guest-session), never here, so a lost
  // first checkout response can never strand an intent its owner
  // cannot prove. Signed-in shoppers need no capability.
  if (!sessionUser && !guestToken)
    return generic(
      'Guest checkout needs a browser session first. Reload and try again.',
      'GUEST_BOOTSTRAP_REQUIRED',
      428
    );

  // New intent: bot/abuse gates run once at creation. Retries of an
  // existing intent are authorized by ownership + fingerprint instead,
  // because Turnstile tokens are single-use.
  const { verifyTurnstile } = await import('../../server/turnstile');
  const turnstileOk = await verifyTurnstile(env, body.turnstileToken, {
    expectedAction: 'checkout',
    expectedHostname: new URL(request.url).hostname,
    remoteIp: request.headers.get('CF-Connecting-IP') ?? undefined,
  });
  if (!turnstileOk) return generic('Bot verification failed. Please try again.', 'BOT', 403);

  const effectiveGuestToken = guestToken;
  if (!cartCreds || !cart || cart.status !== 'open')
    return generic('Your cart is unavailable. Reload and try again.', 'CONFLICT', 409);
  const currentLines = await env.DB.prepare(
    'SELECT sku,qty FROM cart_items WHERE cart_id=? ORDER BY sku'
  )
    .bind(cartCreds.id)
    .all<{ sku: string; qty: number }>();
  const merged = new Map<string, number>();
  for (const line of body.lines) merged.set(line.sku, (merged.get(line.sku) ?? 0) + line.qty);
  if (
    JSON.stringify(currentLines.results.map((l) => [l.sku, l.qty])) !==
    JSON.stringify([...merged].sort(([a], [b]) => a.localeCompare(b)))
  )
    return generic('Your cart changed. Review it again.', 'CONFLICT', 409);
  const settings = await getSettings(env.DB);
  // The shopper confirmed pricing at quoteRevision; if commerce
  // configuration moved since, reject for requote rather than charge
  // different amounts. The batch guard separately covers changes
  // landing between this read and the reservation commit.
  if (body.quoteRevision === undefined || !body.confirmedQuote)
    return generic('Confirm the current quote before checkout', 'VALIDATION', 400);
  if (body.quoteRevision !== settings.configRevision)
    return generic(
      'Store pricing changed; review your updated order and resubmit',
      'STALE_QUOTE',
      409
    );
  // Quote-bound submission: the shopper confirmed a normalized
  // breakdown (lines, coupon, shipping selection, total). Recompute
  // the authoritative quote from exactly those submitted inputs and
  // reject any drift for requote instead of charging a different
  // amount. Stock and coupon-capacity guards still run separately
  // inside createPendingOrder.
  let authoritative: Awaited<ReturnType<typeof quoteOrder>>;
  {
    try {
      authoritative = await quoteOrder(
        env.DB,
        {
          email: body.email,
          lines: body.lines,
          discountCode: body.discountCode,
          shippingRateId: body.shippingRateId,
          shippingCountry: body.shippingCountry,
        },
        settings
      );
    } catch (err) {
      if (err instanceof CheckoutError)
        return Response.json({ error: err.message, code: err.code }, { status: err.status });
      throw err;
    }
    if (
      authoritative.subtotalCents !== body.confirmedQuote.subtotalCents ||
      authoritative.discountCents !== body.confirmedQuote.discountCents ||
      authoritative.shippingCents !== body.confirmedQuote.shippingCents ||
      authoritative.totalCents !== body.confirmedQuote.totalCents
    )
      return generic(
        'Store pricing changed; review your updated order and resubmit',
        'STALE_QUOTE',
        409
      );
  }
  // Success/cancel URLs are built on the server from the configured
  // base URL — never accepted from the client (open redirect).
  const base = (settings.canonicalBaseUrl || new URL(request.url).origin).replace(/\/$/, '');
  const secret = env.BETTER_AUTH_SECRET ?? '';

  const intent: CheckoutIntentInsert = {
    id: body.intentId,
    ownerType: sessionUser ? 'account' : 'guest',
    userId: sessionUser?.id ?? null,
    guestCapabilityHash: sessionUser
      ? null
      : effectiveGuestToken
        ? await sha256Hex(effectiveGuestToken)
        : null,
    fingerprint,
    sessionExpiresAt: '',
    holdExpiresAt: null,
    manualCapture: true,
    shippingAddress: body.shippingAddress,
    cartId: cartCreds.id,
    cartRevision: cart.revision,
    reminderConsent: body.reminderConsent,
    payloadFor: async (quote, orderId) => {
      const token = secret ? await createOrderAccessToken(secret, orderId) : '';
      const expiresAtEpochSeconds =
        Math.floor(Date.now() / 1000) + quote.limits.checkout_session_minutes * 60;
      intent.sessionExpiresAt = new Date(expiresAtEpochSeconds * 1000).toISOString();
      return {
        orderId,
        attemptId: body.intentId,
        email: body.email,
        currency: quote.currency,
        lineItems: quote.items.map((i) => ({
          name: i.title,
          unitAmountCents: i.unitPriceCents,
          qty: i.qty,
          taxCode: i.taxCode,
        })),
        discountCents: quote.discountCents,
        discountCode: quote.discount?.code,
        shippingCents: quote.shippingCents,
        successUrl: `${base}/checkout/success?order=${orderId}${token ? `&t=${token}` : ''}`,
        cancelUrl: `${base}/cart`,
        collectShipping: false,
        manualCapture: true,
        shippingAddress: body.shippingAddress,
        shippingCountries: [body.shippingCountry],
        automaticTax: settings.stripeTaxEnabled && settings.stripeTaxConfirmed,
        expiresAtEpochSeconds,
      };
    },
  };

  // Admission (Phase 5): only genuinely new starts consume capacity —
  // replays of an existing intent returned above without a permit.
  // Denied starts create no intent or order, reserve no stock and
  // never reach the provider.
  const permit = await acquireCheckoutPermit(env.CHECKOUT_ADMISSION, 'start');
  if (permit.kind === 'busy') {
    console.warn(
      JSON.stringify({
        event: 'checkout_admission_busy',
        retryAfterSeconds: permit.retryAfterSeconds,
      })
    );
    const res = generic('Checkout is busy. Please retry in a moment.', 'CHECKOUT_BUSY', 429);
    res.headers.set('Retry-After', String(permit.retryAfterSeconds));
    return res;
  }
  if (permit.kind === 'unavailable') {
    console.warn(JSON.stringify({ event: 'checkout_admission_unavailable' }));
    return generic(
      'Checkout is temporarily unavailable. Please retry shortly.',
      'CHECKOUT_UNAVAILABLE',
      503
    );
  }
  const deadlineMs = options?.deadlineMs ?? Date.now() + 30_000;
  try {
    try {
      await createPendingOrder(
        env.DB,
        {
          email: body.email,
          userId: sessionUser?.id ?? null,
          ip: request.headers.get('CF-Connecting-IP'),
          lines: body.lines,
          discountCode: body.discountCode,
          shippingRateId: body.shippingRateId,
          shippingCountry: body.shippingCountry,
        },
        intent,
        settings,
        authoritative
      );
      const retired = await env.DB.prepare(
        "SELECT id FROM checkout_intents WHERE superseded_by=? AND payment_state NOT IN ('finalized','canceled') ORDER BY created_at LIMIT 20"
      )
        .bind(intent.id)
        .all<{ id: string }>();
      const { enqueueJob } = await import('../../server/email');
      for (const old of retired.results)
        await enqueueJob({ type: 'checkout.recover', intentId: old.id });
    } catch (err) {
      if (err instanceof CheckoutError) {
        if (err.code === 'INTENT_EXISTS') {
          // Concurrent duplicate won the insert: replay the winner.
          const winner = await loadIntent(env.DB, body.intentId);
          if (winner)
            return respondForIntent(
              env.DB,
              provider,
              request,
              winner,
              {
                userId: sessionUser?.id ?? null,
                guestToken: effectiveGuestToken,
                fingerprint,
                secure,
                accessSecret: secret,
              },
              { permitHeld: true, deadlineMs }
            );
        }
        return Response.json({ error: err.message, code: err.code }, { status: err.status });
      }
      if (err instanceof InsufficientStock)
        return generic('Some items are no longer available', 'STOCK', 409);
      console.error(
        JSON.stringify({
          event: 'checkout_failed',
          error: err instanceof Error ? err.message : 'unknown',
        })
      );
      return generic('Checkout failed. Please try again.', 'INTERNAL', 500);
    }

    const created = await loadIntent(env.DB, body.intentId);
    if (!created) return generic('Checkout failed. Please try again.', 'INTERNAL', 500);
    // Orchestration deadline (Phase 5): if the guarded work already
    // overran, do not start the provider operation. The intent exists,
    // so the shopper's retry replays it without consuming admission.
    if (Date.now() > deadlineMs)
      return generic('Checkout timed out. Please retry.', 'TIMEOUT', 503);
    const res = await respondForIntent(
      env.DB,
      provider,
      request,
      created,
      {
        userId: sessionUser?.id ?? null,
        guestToken: effectiveGuestToken,
        fingerprint,
        secure,
        accessSecret: secret,
      },
      { permitHeld: true, deadlineMs }
    );
    return res;
  } finally {
    await permit.release();
  }
}

async function respondForIntent(
  db: D1Database,
  provider: PaymentProvider,
  request: Request,
  intent: CheckoutIntentRow,
  who: {
    userId: string | null;
    guestToken: string | null;
    fingerprint: string;
    secure: boolean;
    accessSecret: string;
  },
  opts: {
    permitHeld?: boolean;
    deadlineMs?: number;
    admission?: {
      getByName(name: string): import('../../server/checkout-admission').AdmissionStub;
    };
  } = {}
): Promise<Response> {
  // Ownership before anything else: a mismatch must not reveal another
  // shopper's checkout state, URL or totals. A concurrent duplicate that
  // lost the insert race (same fingerprint, capability cookie not yet
  // stored) gets a neutral pending response; its next retry carries the
  // winner's cookie and succeeds.
  if (!(await intentOwnedBy(intent, who))) {
    if (intent.fingerprint !== who.fingerprint)
      return generic('Checkout not found', 'NOT_FOUND', 404);
    return Response.json({ state: 'pending' }, { status: 202 });
  }
  if (intent.fingerprint !== who.fingerprint)
    return generic(
      'Checkout details changed. Review your order and try again.',
      'STALE_ATTEMPT',
      409
    );
  const order = await db
    .prepare('SELECT id, status, payment_status, total_cents, currency FROM orders WHERE id = ?')
    .bind(intent.order_id)
    .first<{
      id: string;
      status: string;
      payment_status: string;
      total_cents: number;
      currency: string;
    }>();
  if (!order) return generic('Checkout not found', 'NOT_FOUND', 404);
  const completedResponse = async () => {
    const token = who.accessSecret ? await createOrderAccessToken(who.accessSecret, order.id) : '';
    return Response.json({
      state: 'already_paid',
      orderId: order.id,
      orderUrl: `/checkout/success?order=${encodeURIComponent(order.id)}${token ? `&t=${encodeURIComponent(token)}` : ''}`,
    });
  };
  if (order.payment_status === 'paid') return completedResponse();
  const currentCart = await cartIdentity(db, parseCartCookie(request.headers.get('cookie')));
  if (
    !currentCart ||
    currentCart.id !== intent.cart_id ||
    currentCart.revision !== intent.cart_revision ||
    currentCart.status !== 'open'
  )
    return generic(
      'Your cart changed. Reload it and review your order again.',
      'STALE_ATTEMPT',
      409
    );
  if (intent.state === 'canceled' || intent.state === 'expired')
    return generic('This checkout attempt has ended. Start a new checkout.', 'TERMINAL', 409);
  if (intent.cancel_requested || intent.superseded_by)
    return generic('This checkout was replaced. Review your current order.', 'TERMINAL', 409);

  // Read-only fast path: a ready intent whose order can still be paid
  // returns its URL without admission or provider work. A terminal
  // order retires it instead of resurrecting the session.
  if (
    intent.state === 'ready' &&
    intent.checkout_url &&
    intent.session_expires_at > new Date().toISOString()
  ) {
    if (order.status !== 'pending_payment')
      return generic('This checkout attempt has ended. Start a new checkout.', 'TERMINAL', 409);
    if (intent.flow !== 'manual_capture')
      return readyResponse(db, request, order, intent.checkout_url);
    if (intent.quote_json)
      return Response.json({
        state: 'review_ready',
        intentId: intent.id,
        orderId: order.id,
        quote: JSON.parse(intent.quote_json),
        quoteHash: intent.quote_hash,
        expiresAt: intent.session_expires_at,
      });
  }

  // Anything else may reach the provider (resume/recovery), so it
  // consumes admission exactly like a new start. Only genuinely
  // read-only responses are permit-free.
  let release: (() => Promise<void>) | null = null;
  if (!opts.permitHeld) {
    const permit = await acquireCheckoutPermit(opts.admission, 'start');
    if (permit.kind === 'busy') {
      console.warn(
        JSON.stringify({
          event: 'checkout_admission_busy',
          retryAfterSeconds: permit.retryAfterSeconds,
        })
      );
      const res = generic('Checkout is busy. Please retry in a moment.', 'CHECKOUT_BUSY', 429);
      res.headers.set('Retry-After', String(permit.retryAfterSeconds));
      return res;
    }
    if (permit.kind === 'unavailable') {
      console.warn(JSON.stringify({ event: 'checkout_admission_unavailable' }));
      return generic(
        'Checkout is temporarily unavailable. Please retry shortly.',
        'CHECKOUT_UNAVAILABLE',
        503
      );
    }
    release = permit.release;
  }
  try {
    const result = await runIntentOperation(db, provider, intent.id, {
      ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
    });
    switch (result.status) {
      case 'ready':
        if (intent.flow === 'manual_capture') {
          const fresh = (await loadIntent(db, intent.id))!;
          const quote = await prepareReview(
            db,
            provider,
            fresh,
            opts.deadlineMs ?? Date.now() + 30_000
          );
          const frozen = (await loadIntent(db, intent.id))!;
          return Response.json({
            state: 'review_ready',
            intentId: intent.id,
            orderId: order.id,
            quote,
            quoteHash: frozen.quote_hash,
            expiresAt: frozen.session_expires_at,
          });
        }
        return readyResponse(db, request, order, result.checkoutUrl);
      case 'already_paid':
        return completedResponse();
      case 'pending':
        return Response.json({ state: 'pending', orderId: order.id }, { status: 202 });
      case 'expired':
        return generic('This checkout attempt has ended. Start a new checkout.', 'TERMINAL', 409);
      case 'canceled':
        return generic('This checkout attempt has ended. Start a new checkout.', 'TERMINAL', 409);
    }
  } finally {
    await release?.();
  }
  return Response.json({ state: 'pending', orderId: order.id }, { status: 202 });
}

async function readyResponse(
  db: D1Database,
  request: Request,
  order: { id: string; total_cents: number; currency: string },
  checkoutUrl: string
): Promise<Response> {
  // Only now — the Stripe session exists — is the cart converted.
  // Cart conversion is cleanup: a failure here must never strand the
  // shopper. Log it and still return the URL.
  try {
    await convertCart(db, parseCartCookie(request.headers.get('cookie')));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'cart_convert_failed',
        orderId: order.id,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }
  const response = Response.json({
    state: 'ready',
    orderId: order.id,
    checkoutUrl,
    totalCents: order.total_cents,
    currency: order.currency,
  });
  // The cart is converted server-side; clear its cookies here so the
  // shopper leaves with no stale cart identity or badge count.
  response.headers.append('Set-Cookie', clearCartCookieHeader);
  response.headers.append('Set-Cookie', cartCountCookieHeader(0));
  return response;
}

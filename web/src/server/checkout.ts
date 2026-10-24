import { cancelOrdersStatements } from './order-cancellation';
import { recoveryContext, webhookDue, type RecoveryContext } from './recovery-eligibility';
import { resolvePaymentOrder } from './payment-order';
import { releaseOrderHoldsStmts, InsufficientStock } from './inventory';
import { getSettings, readSettings } from './settings';
import { inArray, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { variants as variantsT, products as productsT } from '../db/schema';
import {
  checkoutMetadataSchema,
  stripeEventSchema,
  shippingDetailsSchema,
  handledStripeSchemas,
} from '../schemas/webhook';
import { emailStatement, operationalRecipients, commitWithEmails } from './email';
import {
  requestRefund,
  handleRefundEvent,
  reconcileRefundOperations,
  syncChargeRefund,
} from './refunds';
import { normalizeNetwork } from './network';
import { nextRetryIso } from './retry';
import type { PaymentProvider } from './payments';

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

export function orderNumber(): string {
  const d = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) suffix += chars[b % chars.length];
  return `ORD-${d}-${suffix}`;
}

export type CartLine = { sku: string; qty: number };

/** Discounts exclude shipping. Checkout always revalidates current D1 settings. */
export async function calculateDiscount(
  db: D1Database,
  code: string,
  subtotalCents: number,
  email: string | null
): Promise<{ id: string; code: string; type: string; value: number; amountCents: number } | null> {
  const d = await db
    .prepare(
      'SELECT id, code, type, value, min_purchase_cents, max_discount_cents, starts_at, expires_at, usage_limit, usage_count, usage_per_customer FROM discounts WHERE code = ? AND status = ?'
    )
    .bind(code.toUpperCase(), 'active')
    .first<{
      id: string;
      code: string;
      type: string;
      value: number;
      min_purchase_cents: number;
      max_discount_cents: number | null;
      starts_at: string | null;
      expires_at: string | null;
      usage_limit: number | null;
      usage_count: number;
      usage_per_customer: number;
    }>();
  if (!d) return null;
  if (!Number.isSafeInteger(d.value) || d.value < 0 || (d.type === 'percentage' && d.value > 100))
    return null;
  const nowIso = now();
  if (d.starts_at && d.starts_at > nowIso) return null;
  if (d.expires_at && d.expires_at < nowIso) return null;
  if (subtotalCents < d.min_purchase_cents) return null;
  if (d.usage_limit != null && d.usage_count >= d.usage_limit) return null;
  if (email !== null) {
    const prior = await db
      .prepare(
        'SELECT COUNT(*) AS c FROM discount_usage WHERE discount_id = ? AND customer_email = ?'
      )
      .bind(d.id, email.toLowerCase())
      .first<{ c: number }>();
    if ((prior?.c ?? 0) >= d.usage_per_customer) return null;
  }
  let amount =
    d.type === 'percentage'
      ? Math.floor((subtotalCents * d.value) / 100)
      : Math.min(d.value, subtotalCents);
  if (d.max_discount_cents != null) amount = Math.min(amount, d.max_discount_cents);
  amount = Math.max(0, Math.min(amount, subtotalCents));
  return { id: d.id, code: d.code, type: d.type, value: d.value, amountCents: amount };
}

export class CheckoutError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = 'VALIDATION'
  ) {
    super(message);
  }
}

export async function calculateShipping(
  db: D1Database,
  rateId: string | undefined,
  subtotalCents: number,
  totalWeightGrams: number,
  country?: string
): Promise<number> {
  if (!rateId || !country) throw new CheckoutError('Select a shipping country and rate');
  const rate = await db
    .prepare(
      `SELECT r.*, z.countries_json FROM shipping_rates r JOIN shipping_zones z ON z.id = r.zone_id WHERE r.id = ?`
    )
    .bind(rateId)
    .first<{
      kind: string;
      amount_cents: number;
      free_over_cents: number | null;
      per_kg_cents: number | null;
      countries_json: string;
    }>();
  if (!rate) throw new CheckoutError('Unknown shipping rate');
  let countries: unknown;
  try {
    countries = JSON.parse(rate.countries_json);
  } catch {
    throw new CheckoutError('Shipping configuration unavailable', 503, 'DEPENDENCY');
  }
  if (!Array.isArray(countries) || !countries.includes(country))
    throw new CheckoutError('Shipping rate is not available for this country');
  if (
    rate.kind === 'free_over' &&
    rate.free_over_cents != null &&
    subtotalCents >= rate.free_over_cents
  )
    return 0;
  return (
    rate.amount_cents +
    (rate.kind === 'weight' ? Math.ceil(totalWeightGrams / 1000) * (rate.per_kg_cents ?? 0) : 0)
  );
}

type OrderInput = {
  email: string;
  userId?: string | null;
  ip?: string | null;
  lines: CartLine[];
  discountCode?: string | undefined;
  shippingRateId?: string | undefined;
  shippingCountry?: string | undefined;
};

export async function quoteOrder(
  db: D1Database,
  input: OrderInput,
  suppliedSettings?: Awaited<ReturnType<typeof getSettings>>
) {
  if (!input.lines?.length) throw new CheckoutError('Cart is empty');
  if (input.lines.length > 100) throw new CheckoutError('Too many lines in one order');
  // One settings read per initiation: the route passes the snapshot it
  // already loaded instead of quote + submit reading it twice.
  const settings = suppliedSettings ?? (await getSettings(db));
  const limits = settings.limits;
  const merged = new Map<string, number>();
  for (const l of input.lines) {
    if (!l.sku || !Number.isInteger(l.qty) || l.qty < 1 || l.qty > limits.cart_max_qty)
      throw new CheckoutError('Invalid quantity');
    merged.set(l.sku, (merged.get(l.sku) ?? 0) + l.qty);
  }
  if (merged.size > limits.cart_max_lines) throw new CheckoutError('Too many lines in one order');
  if (
    [...merged.values()].some((q) => q > limits.cart_max_qty) ||
    [...merged.values()].reduce((a, b) => a + b, 0) > limits.order_max_units
  )
    throw new CheckoutError('Too many units in one order');
  if (settings.stripeTaxEnabled && !settings.stripeTaxConfirmed)
    throw new CheckoutError('Tax configuration is incomplete', 503, 'DEPENDENCY');
  const rows = await getDb(db)
    .select({
      sku: variantsT.sku,
      title: productsT.title,
      priceCents: variantsT.priceCents,
      status: variantsT.status,
      productStatus: productsT.status,
      weightGrams: variantsT.weightGrams,
      taxCode: productsT.taxCode,
    })
    .from(variantsT)
    .innerJoin(productsT, eq(productsT.id, variantsT.productId))
    .where(inArray(variantsT.sku, [...merged.keys()]));
  const bySku = new Map(rows.map((v) => [v.sku, v]));
  const items = [...merged].map(([sku, qty]) => {
    const v = bySku.get(sku);
    if (!v || v.status !== 'active' || v.productStatus !== 'active')
      throw new CheckoutError(`SKU not active: ${sku}`);
    return {
      sku,
      qty,
      title: v.title,
      unitPriceCents: v.priceCents,
      weightGrams: v.weightGrams ?? 0,
      taxCode: v.taxCode,
    };
  });
  if (settings.stripeTaxEnabled && items.some((i) => !i.taxCode || !i.taxCode.startsWith('txcd_')))
    throw new CheckoutError('Product tax configuration is incomplete', 503, 'DEPENDENCY');
  const subtotalCents = items.reduce((s, i) => s + i.unitPriceCents * i.qty, 0);
  const totalWeightGrams = items.reduce((s, i) => s + i.weightGrams * i.qty, 0);
  const discount = input.discountCode
    ? await calculateDiscount(
        db,
        input.discountCode,
        subtotalCents,
        input.email.trim().toLowerCase()
      )
    : null;
  if (input.discountCode && !discount)
    throw new CheckoutError('Discount code is not valid for this order');
  const discountCents = discount?.amountCents ?? 0;
  const shippingCents = await calculateShipping(
    db,
    input.shippingRateId,
    subtotalCents - discountCents,
    totalWeightGrams,
    input.shippingCountry
  );
  return {
    items,
    subtotalCents,
    totalWeightGrams,
    discountCents,
    shippingCents,
    totalCents: subtotalCents - discountCents + shippingCents,
    discount,
    currency: settings.currency,
    limits,
    configRevision: settings.configRevision,
  };
}

export type CheckoutIntentInsert = {
  id: string;
  ownerType: 'account' | 'guest';
  userId: string | null;
  guestCapabilityHash: string | null;
  fingerprint: string;
  sessionExpiresAt: string;
  shippingAddress?: import('../schemas/checkout').ShippingAddress;
  cartId?: string;
  cartRevision?: number;
  reminderConsent?: boolean;
  payloadFor: (
    quote: Awaited<ReturnType<typeof quoteOrder>>,
    orderId: string
  ) => Promise<Record<string, unknown>>;
};

export async function createPendingOrder(
  db: D1Database,
  input: OrderInput,
  intent: CheckoutIntentInsert,
  suppliedSettings?: Awaited<ReturnType<typeof getSettings>>,
  suppliedQuote?: Awaited<ReturnType<typeof quoteOrder>>
) {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new CheckoutError('A valid email is required');
  const quote = suppliedQuote ?? (await quoteOrder(db, input, suppliedSettings));
  const orderId = id(),
    attemptId = intent.id,
    at = now();
  const payloadJson = JSON.stringify(await intent.payloadFor(quote, orderId));
  const itemsJson = JSON.stringify(
    quote.items.map((i) => ({
      id: id(),
      sku: i.sku,
      title: i.title,
      qty: i.qty,
      unitPriceCents: i.unitPriceCents,
    }))
  );
  const statements: D1PreparedStatement[] = [
    ...(input.userId
      ? [
          db
            .prepare(
              'INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM user WHERE id=?)'
            )
            .bind(input.userId),
        ]
      : []),
    db
      .prepare(
        `INSERT INTO orders (id, number, customer_email, user_id, currency, subtotal_cents, discount_cents, shipping_cents, total_cents, discount_id, checkout_attempt_id, checkout_intent_id, customer_ip, shipping_country, shipping_rate_id,reminder_consent, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`
      )
      .bind(
        orderId,
        orderNumber(),
        email,
        input.userId ?? null,
        quote.currency,
        quote.subtotalCents,
        quote.discountCents,
        quote.shippingCents,
        quote.totalCents,
        quote.discount?.id ?? null,
        attemptId,
        intent.id,
        input.ip ? normalizeNetwork(input.ip) : null,
        input.shippingCountry!,
        input.shippingRateId!,
        intent.reminderConsent ? 1 : 0,
        at,
        at
      ),
    db
      .prepare(
        `INSERT INTO checkout_intents (id, order_id, owner_type, user_id, guest_capability_hash, fingerprint, state, provider_payload_json, payload_version, coupon_idempotency_key, session_idempotency_key, session_expires_at,shipping_address_json,cart_id,cart_revision,payment_next_at,created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        intent.id,
        orderId,
        intent.ownerType,
        intent.userId,
        intent.guestCapabilityHash,
        intent.fingerprint,
        payloadJson,
        `coupon_${intent.id}`,
        `checkout_${intent.id}`,
        intent.sessionExpiresAt,
        intent.shippingAddress ? JSON.stringify(intent.shippingAddress) : null,
        intent.cartId ?? null,
        intent.cartRevision ?? null,
        intent.sessionExpiresAt,
        at,
        at
      ),
    db
      .prepare(
        'INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM orders WHERE id = ?)'
      )
      .bind(orderId),
    ...(intent.cartId
      ? [
          db
            .prepare(
              "INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM carts WHERE id=? AND revision=? AND status='open')"
            )
            .bind(intent.cartId, intent.cartRevision),
          db
            .prepare(
              `UPDATE checkout_intents SET superseded_by=?,cancel_requested=1,creation_stopped_at=COALESCE(creation_stopped_at,?),payment_next_at=? WHERE cart_id=? AND id!=? AND payment_state NOT IN ('finalized','canceled')`
            )
            .bind(intent.id, at, at, intent.cartId, intent.id),
          db
            .prepare('UPDATE carts SET active_checkout_id=? WHERE id=?')
            .bind(intent.id, intent.cartId),
        ]
      : []),
    // Stale-quote guard: pricing/shipping/coupon/settings changed since
    // the quote was computed. Abort rather than charge a changed price;
    // stock-only movement does not advance the revision.
    db
      .prepare(
        `INSERT INTO batch_guard (id) SELECT 'stale-quote' WHERE (SELECT value FROM settings WHERE key = 'commerce_revision') IS NOT ?`
      )
      .bind(String(quote.configRevision)),
    db
      .prepare(
        `INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents)
         SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.sku'), json_extract(value, '$.title'), CAST(json_extract(value, '$.qty') AS INTEGER), CAST(json_extract(value, '$.unitPriceCents') AS INTEGER) FROM json_each(?)`
      )
      .bind(orderId, itemsJson),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (
      /UNIQUE constraint failed:\s*(checkout_intents\.|orders\.checkout_(?:attempt|intent)_id)/.test(
        message
      )
    )
      throw new CheckoutError('Checkout already exists', 409, 'INTENT_EXISTS');
    if (/checkout currency changed/.test(message))
      throw new CheckoutError('Store currency changed; refresh checkout', 409, 'VALIDATION');
    if (/Too many open checkouts/.test(message))
      throw new CheckoutError(
        'Too many open checkouts; finish or wait for an earlier checkout to expire',
        429,
        'ABUSE_LIMIT'
      );
    if (/batch_guard|CHECK|reserved cannot/.test(message)) {
      const current = await readSettings(db).catch(() => null);
      if (current && current.configRevision !== quote.configRevision)
        throw new CheckoutError(
          'Store pricing changed; review your order and resubmit',
          409,
          'STALE_QUOTE'
        );
      if (
        quote.discount &&
        !(await calculateDiscount(db, quote.discount.code, quote.subtotalCents, email))
      )
        throw new CheckoutError('Discount code is not valid for this order');
      throw new InsufficientStock(quote.items[0]?.sku ?? 'item');
    }
    throw error;
  }
  return { ...quote, orderId, attemptId };
}

/** Idempotent webhook processing. Returns true when the event was new. */
type StripeEventLike = { id: string; type: string; data: unknown };

/** Verify + durably inbox a Stripe delivery. Processing happens separately
 *  (Queue consumer), so the HTTP response never waits on order work. */
export async function inboxStripeEvent(
  db: D1Database,
  provider: PaymentProvider,
  payload: string,
  signature: string
): Promise<{ eventId: string; duplicate: boolean }> {
  const event = await provider.verifyWebhook(payload, signature);
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO webhook_inbox (id, provider, event_id, type, payload_json, received_at)
       VALUES (?, 'stripe', ?, ?, ?, ?)`
    )
    .bind(id(), event.id, event.type, payload, now())
    .run();
  if ((ins.meta.changes ?? 0) === 0) {
    const existing = await db
      .prepare('SELECT status FROM webhook_inbox WHERE event_id = ?')
      .bind(event.id)
      .first<{ status: string }>();
    if (existing?.status === 'failed') return { eventId: event.id, duplicate: false };
    return { eventId: event.id, duplicate: true };
  }
  return { eventId: event.id, duplicate: false };
}

/** Process one inboxed event by id. Idempotent: state guards in each branch
 *  make replays and out-of-order deliveries safe. */
const DEAD_RETRY_MS = 6 * 60 * 60_000;

export async function failInboxEvent(db: D1Database, eventId: string, deadLetter = false) {
  const current = await db
    .prepare('SELECT type,attempts,status FROM webhook_inbox WHERE event_id=?')
    .bind(eventId)
    .first<{ type: string; attempts: number; status: string }>();
  if (!current) return;
  if (deadLetter) {
    // Dead-lettered: park as 'dead' for the capped cron replay below. The
    // operator email fires once per event: the outbox key is deterministic
    // (`inbox-alert-<event>-<to>`), so later retries cannot re-send it.
    const recipients = await operationalRecipients(db);
    const statements = [
      db
        .prepare(
          "UPDATE webhook_inbox SET status='dead',retry_after=? WHERE event_id=? AND status!='processed'"
        )
        .bind(new Date(Date.now() + DEAD_RETRY_MS).toISOString(), eventId),
    ];
    for (const to of recipients)
      statements.push(
        emailStatement(
          db,
          `inbox-alert-${eventId}-${to}`,
          {
            to,
            subject: `Webhook processing failed permanently: ${current.type}`,
            text: `Stripe event ${eventId} failed processing. Investigate the webhook inbox.`,
            html: `<p>Stripe event ${eventId} failed processing. Investigate the webhook inbox.</p>`,
          },
          {
            sql: "EXISTS(SELECT 1 FROM webhook_inbox WHERE event_id=? AND status='dead')",
            values: [eventId],
          }
        )
      );
    await commitWithEmails(
      db,
      statements,
      recipients.map((to) => `inbox-alert-${eventId}-${to}`)
    );
    console.error(JSON.stringify({ event: 'webhook_inbox_dead_lettered', eventId }));
    return;
  }
  const attempts = current.attempts + 1;
  const dead = attempts >= 5;
  const recipients = dead ? await operationalRecipients(db) : [];
  const statements = [
    db
      .prepare(
        dead
          ? "UPDATE webhook_inbox SET status='dead',attempts=MIN(5,attempts+1),retry_after=? WHERE event_id=? AND status!='processed'"
          : "UPDATE webhook_inbox SET status='failed',attempts=MIN(5,attempts+1),retry_after=? WHERE event_id=? AND status!='processed'"
      )
      .bind(
        dead ? new Date(Date.now() + DEAD_RETRY_MS).toISOString() : nextRetryIso(attempts),
        eventId
      ),
  ];
  for (const to of recipients)
    statements.push(
      emailStatement(
        db,
        `inbox-alert-${eventId}-${to}`,
        {
          to,
          subject: `Webhook processing failed permanently: ${current.type}`,
          text: `Stripe event ${eventId} failed processing. Investigate the webhook inbox.`,
          html: `<p>Stripe event ${eventId} failed processing. Investigate the webhook inbox.</p>`,
        },
        {
          sql: "EXISTS(SELECT 1 FROM webhook_inbox WHERE event_id=? AND attempts>=5 AND status='dead')",
          values: [eventId],
        }
      )
    );
  await commitWithEmails(
    db,
    statements,
    recipients.map((to) => `inbox-alert-${eventId}-${to}`)
  );
  if (attempts >= 5)
    console.error(JSON.stringify({ event: 'webhook_inbox_cap_reached', eventId, attempts }));
}

export async function processInboxEvent(
  db: D1Database,
  eventId: string,
  provider?: PaymentProvider
): Promise<boolean> {
  const row = await db
    .prepare(
      'SELECT event_id, type, payload_json, status, attempts, retry_after FROM webhook_inbox WHERE event_id = ?'
    )
    .bind(eventId)
    .first<{
      event_id: string;
      type: string;
      payload_json: string;
      status: string;
      attempts: number;
      retry_after: string | null;
    }>();
  if (
    !row ||
    row.status === 'processed' ||
    row.attempts >= 5 ||
    (row.retry_after && row.retry_after > now())
  )
    return false;
  let rawEvent: unknown;
  const markFailed = () => failInboxEvent(db, row.event_id);
  try {
    rawEvent = JSON.parse(row.payload_json);
  } catch {
    await markFailed();
    return false;
  }
  const parsedEvent = stripeEventSchema.safeParse(rawEvent);
  if (!parsedEvent.success) {
    await markFailed();
    return false;
  }
  const objectSchema = handledStripeSchemas[row.type];
  if (objectSchema && !objectSchema.safeParse(parsedEvent.data.data.object).success) {
    await markFailed();
    return false;
  }
  const event: StripeEventLike = {
    id: row.event_id,
    type: row.type,
    data: parsedEvent.data.data.object,
  };
  return applyStripeEvent(db, event, provider);
}

// NOTE: there is deliberately no inline "inbox + process" helper in
// production code (Phase 6): the route enqueues, the consumer processes
// via processInboxEvent, and cron recovers. Tests compose the two steps
// through tests/helpers/webhook.ts instead.

/** Cron/DLQ recovery: re-process failed, stale pending, and dead-lettered
 *  inbox rows. Stripe never resends once we ack, so this sweep is the only
 *  recovery path for a handler that failed after the ack. Dead rows are
 *  reset and retried on the capped 6-hour backoff, never terminal. */
export async function reprocessStaleInbox(
  db: D1Database,
  provider: PaymentProvider | null,
  limit = 20,
  dueBefore = now(),
  context?: RecoveryContext
): Promise<number> {
  const due = webhookDue(context ?? (await recoveryContext(db, dueBefore)));
  const rows = await db
    .prepare(
      `SELECT w.event_id,w.status FROM webhook_inbox w WHERE ${due.sql} ORDER BY w.received_at,w.event_id LIMIT ?`
    )
    .bind(...due.values, limit)
    .all<{ event_id: string; status: string }>();
  for (const r of rows.results) {
    if (r.status === 'dead')
      await db
        .prepare(
          "UPDATE webhook_inbox SET status='pending', attempts=0, retry_after=NULL WHERE event_id=? AND status='dead'"
        )
        .bind(r.event_id)
        .run();
  }
  let done = 0;
  for (const r of rows.results) {
    try {
      await processInboxEvent(db, r.event_id, provider ?? undefined);
    } catch {
      // Row stays failed with attempts incremented; next sweep retries until cap.
      console.warn(JSON.stringify({ event: 'webhook_retry_failed' }));
    }
    const stillDue = await db
      .prepare(`SELECT 1 FROM webhook_inbox w WHERE w.event_id=? AND ${due.sql}`)
      .bind(r.event_id, ...due.values)
      .first();
    if (!stillDue) done++;
  }
  return done;
}

async function applyStripeEvent(
  db: D1Database,
  event: StripeEventLike,
  provider?: PaymentProvider
): Promise<boolean> {
  const data = event.data as Record<string, unknown>;
  const sessionId =
    typeof data.id === 'string' && event.type.startsWith('checkout.session')
      ? (data.id as string)
      : null;

  try {
    const { recordAuthorizedEvent } = await import('./authorized-checkout');
    if (await recordAuthorizedEvent(db, event.type, data)) {
      // The manual-capture operation is durable and queued; Session completion is not payment.
    } else if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      const paymentStatus = data.payment_status as string | undefined;
      if (
        event.type === 'checkout.session.completed' &&
        paymentStatus &&
        paymentStatus !== 'paid' &&
        paymentStatus !== 'no_payment_required'
      ) {
        // Delayed payment method: remember the payment intent so failure,
        // refund, and dispute events can find this order before it pays,
        // then wait for async_payment_succeeded.
        if (sessionId && typeof data.payment_intent === 'string') {
          await db
            .prepare(
              'UPDATE orders SET stripe_payment_intent_id = ?, updated_at = ? WHERE stripe_checkout_session_id = ?'
            )
            .bind(data.payment_intent, now(), sessionId)
            .run();
        }
      } else if (sessionId) {
        // A verified webhook can beat local session attachment (crash
        // between Stripe creation and the guarded attach). Resolve the
        // durable intent from provider metadata and attach through the
        // same guard; if the order still cannot be found, fail the event
        // so it retries instead of being marked processed.
        await ensureSessionAttached(db, sessionId, data);
        if (!(await findOrderBySession(db, sessionId)))
          throw new Error('Checkout order has not arrived yet');
        await markOrderPaid(db, sessionId, data, provider);
      }
    } else if (event.type === 'checkout.session.expired' && sessionId) {
      await cancelPendingOrder(db, sessionId);
    } else if (event.type === 'checkout.session.async_payment_failed') {
      if (sessionId) await cancelPendingOrder(db, sessionId);
    } else if (event.type === 'payment_intent.payment_failed') {
      // A declined attempt can be retried within the same Checkout Session.
      // Retain its stock and coupon claims until terminal cancellation/expiry.
      if (typeof data.id === 'string' && data.id.startsWith('pi_')) {
        const byPi = await db
          .prepare('SELECT id FROM orders WHERE stripe_payment_intent_id = ? AND status = ?')
          .bind(data.id, 'pending_payment')
          .first<{ id: string }>();
        if (byPi) {
          await db
            .prepare(
              "UPDATE orders SET payment_status='failed',updated_at=? WHERE id=? AND status='pending_payment' AND payment_status IN ('unpaid','failed')"
            )
            .bind(now(), byPi.id)
            .run();
        } else if (provider?.findCheckoutSessionIdByPaymentIntent) {
          // The PI was never stored locally (session has not completed):
          // resolve it through Stripe's session list without releasing holds.
          const resolvedSessionId = await provider.findCheckoutSessionIdByPaymentIntent(data.id);
          if (resolvedSessionId)
            await db
              .prepare(
                "UPDATE orders SET stripe_payment_intent_id=?,payment_status='failed',updated_at=? WHERE stripe_checkout_session_id=? AND status='pending_payment' AND payment_status IN ('unpaid','failed')"
              )
              .bind(data.id, now(), resolvedSessionId)
              .run();
        }
      }
    } else if (event.type === 'refund.updated' || event.type === 'refund.failed') {
      // Refund settlement (Stripe Node 23: refund.updated / refund.failed
      // are the lifecycle events; charge.refunded is the charge-level view).
      await handleRefundEvent(db, event.type, data, provider);
    } else if (event.type === 'charge.refunded') {
      await syncChargeRefund(db, data, provider);
    } else if (
      (event.type === 'charge.dispute.closed' || event.type === 'charge.dispute.created') &&
      data.payment_intent === null
    ) {
      // Checkout always creates a PaymentIntent, so this dispute is not for one of our orders.
      console.warn(
        JSON.stringify({ event: 'webhook_dispute_unmatched', type: event.type, eventId: event.id })
      );
    } else if (event.type === 'charge.dispute.closed' || event.type === 'charge.dispute.created') {
      const pi = typeof data.payment_intent === 'string' ? data.payment_intent : null;
      if (!pi || !(await resolvePaymentOrder(db, pi, provider)))
        throw new Error('Dispute order has not arrived yet');
      if (event.type === 'charge.dispute.closed') {
        if (
          data.status === 'won' ||
          data.status === 'warning_closed' ||
          data.status === 'prevented'
        ) {
          await db.batch([
            db
              .prepare(
                `UPDATE orders SET payment_status=CASE WHEN status IN ('pending_payment','canceled') THEN 'unpaid' WHEN (SELECT COALESCE(SUM(amount_cents),0) FROM refunds WHERE order_id=orders.id AND status='succeeded')>=total_cents THEN 'refunded' WHEN EXISTS(SELECT 1 FROM refunds WHERE order_id=orders.id AND status='succeeded') THEN 'partially_refunded' ELSE 'paid' END,updated_at=? WHERE stripe_payment_intent_id=?`
              )
              .bind(now(), pi),
            db
              .prepare(
                `UPDATE webhook_inbox SET status='pending',attempts=0,retry_after=?,processed_at=NULL
              WHERE event_id!=? AND type IN ('checkout.session.completed','checkout.session.async_payment_succeeded') AND json_valid(payload_json)
              AND (json_extract(payload_json,'$.data.object.metadata.order_id') IN (SELECT id FROM orders WHERE stripe_payment_intent_id=?)
                OR json_extract(payload_json,'$.data.object.id') IN (SELECT stripe_checkout_session_id FROM orders WHERE stripe_payment_intent_id=?))`
              )
              .bind(now(), event.id, pi, pi),
          ]);
          const due = await db
            .prepare(
              `SELECT event_id FROM webhook_inbox WHERE status='pending' AND type IN ('checkout.session.completed','checkout.session.async_payment_succeeded') AND json_valid(payload_json) AND json_extract(payload_json,'$.data.object.metadata.order_id') IN (SELECT id FROM orders WHERE stripe_payment_intent_id=?) LIMIT 20`
            )
            .bind(pi)
            .all<{ event_id: string }>();
          const { enqueueJob } = await import('./email');
          for (const row of due.results)
            await enqueueJob({ type: 'webhook.process', eventId: row.event_id });
        } else if (data.status === 'lost') {
          const recipients = await operationalRecipients(db);
          await commitWithEmails(
            db,
            [
              db
                .prepare(
                  "UPDATE orders SET payment_status='disputed',updated_at=? WHERE stripe_payment_intent_id=?"
                )
                .bind(now(), pi),
              ...recipients.map((to) =>
                emailStatement(db, `dispute-lost-${String(data.id)}-${to}`, {
                  to,
                  subject: 'Charge dispute lost',
                  text: `Dispute ${String(data.id)} was lost. This is a chargeback; no customer refund was recorded.`,
                  html: '<p>A charge dispute was lost. Check Stripe and the associated order.</p>',
                })
              ),
            ],
            recipients.map((to) => `dispute-lost-${String(data.id)}-${to}`)
          );
        } else {
          throw new Error(`Unhandled dispute status ${String(data.status)}`);
        }
      } else {
        await db
          .prepare(
            `UPDATE orders SET payment_status='disputed',updated_at=? WHERE stripe_payment_intent_id=? AND NOT EXISTS(SELECT 1 FROM webhook_inbox WHERE type='charge.dispute.closed' AND json_valid(payload_json) AND json_extract(payload_json,'$.data.object.id')=?)`
          )
          .bind(now(), pi, String(data.id))
          .run();
      }
    } else {
      // Not one of the subscribed payment events: ack-and-ignore is
      // correct (Stripe endpoints can receive account-level noise), but
      // it must be visible, never silent.
      console.warn(
        JSON.stringify({ event: 'webhook_event_ignored', type: event.type, eventId: event.id })
      );
    }
    await db
      .prepare(`UPDATE webhook_inbox SET status = 'processed', processed_at = ? WHERE event_id = ?`)
      .bind(now(), event.id)
      .run();
  } catch (err) {
    await failInboxEvent(db, event.id);
    throw err;
  }
  return true;
}

async function findOrderBySession(db: D1Database, sessionId: string) {
  return db
    .prepare(
      'SELECT id, status, number, customer_email, total_cents, currency FROM orders WHERE stripe_checkout_session_id = ?'
    )
    .bind(sessionId)
    .first<{
      id: string;
      status: string;
      number: string;
      customer_email: string;
      total_cents: number;
      currency: string;
    }>();
}

/** Signed, unguessable access token for the guest success page. Keyed with
 *  the auth secret; possession of the order id alone is not enough. */
export async function createOrderAccessToken(secret: string, orderId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`order:${orderId}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyOrderAccessToken(
  secret: string,
  orderId: string,
  token: string
): Promise<boolean> {
  if (!token) return false;
  const expected = await createOrderAccessToken(secret, orderId);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

/** Guarded session attachment shared by the intent flow and early
 *  webhooks: attaches only when no conflicting session is present, and
 *  moves the owning intent to ready. Same-session replay is a no-op. */
export async function ensureSessionAttached(
  db: D1Database,
  sessionId: string,
  data: Record<string, unknown>
) {
  if (await findOrderBySession(db, sessionId)) return;
  const metadata = checkoutMetadataSchema.safeParse(data.metadata ?? {});
  if (!metadata.success) return;
  const orderId = metadata.data.order_id;
  const url = typeof data.url === 'string' ? data.url : null;
  // A session naming an attempt must attach to that attempt's intent;
  // anything else is not evidence this order's checkout is ready.
  if (metadata.data.attempt_id) {
    const intent = await db
      .prepare('SELECT id FROM checkout_intents WHERE id = ? AND order_id = ?')
      .bind(metadata.data.attempt_id, orderId)
      .first<{ id: string }>();
    if (!intent) {
      console.error(
        JSON.stringify({ event: 'checkout_session_attach_unmatched', sessionId, orderId })
      );
      return;
    }
  }
  await db.batch([
    db
      .prepare(
        `INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(
      SELECT 1 FROM orders WHERE id=? AND (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id=?))`
      )
      .bind(orderId, sessionId),
    db
      .prepare(
        `INSERT INTO batch_guard SELECT 1 WHERE EXISTS(
      SELECT 1 FROM checkout_intents WHERE order_id=? AND stripe_session_id IS NOT NULL AND stripe_session_id!=?)`
      )
      .bind(orderId, sessionId),
    db
      .prepare('UPDATE orders SET stripe_checkout_session_id=?,updated_at=? WHERE id=?')
      .bind(sessionId, now(), orderId),
    db
      .prepare(
        `UPDATE checkout_intents SET state=CASE WHEN state IN ('canceled','expired') THEN state ELSE 'ready' END,
      stripe_session_id=?,checkout_url=COALESCE(?,checkout_url),fencing=fencing+1,claim_token=NULL,claim_expires_at=NULL,updated_at=? WHERE order_id=?`
      )
      .bind(sessionId, url, now(), orderId),
  ]);
}

export const reconcileLateRefunds = reconcileRefundOperations;

/** A verified capture refunded before fulfillment must terminate without another refund. */
export async function compensateRefundedCheckout(
  db: D1Database,
  orderId: string,
  verifiedLegacyPayment?: { sessionId: string; amountCents: number }
): Promise<boolean> {
  const transition = crypto.randomUUID();
  const gate = {
    sql: 'EXISTS(SELECT 1 FROM orders WHERE id=? AND transition_id=?)',
    values: [orderId, transition],
  };
  const result = await db.batch([
    db
      .prepare(
        `UPDATE orders SET status='canceled',payment_status=CASE WHEN payment_status='disputed' THEN 'disputed' ELSE 'refunded' END,transition_id=?,updated_at=?
      WHERE id=? AND status IN ('pending_payment','canceled') AND total_cents>0
      AND COALESCE((SELECT SUM(amount_cents) FROM refunds WHERE order_id=orders.id AND status='succeeded'),0)>=MAX(total_cents,COALESCE(?,total_cents))
      AND (EXISTS(SELECT 1 FROM checkout_intents ci WHERE ci.order_id=orders.id AND ci.captured_at IS NOT NULL AND ci.payment_state='captured')
        OR (stripe_checkout_session_id=? AND NOT EXISTS(SELECT 1 FROM checkout_intents ci WHERE ci.order_id=orders.id)))
      AND NOT EXISTS(SELECT 1 FROM reservations WHERE order_id=orders.id AND status='committed')`
      )
      .bind(
        transition,
        now(),
        orderId,
        verifiedLegacyPayment?.amountCents ?? null,
        verifiedLegacyPayment?.sessionId ?? null
      ),
    db
      .prepare(
        `UPDATE checkout_intents SET payment_state='finalized',payment_next_at=NULL,updated_at=? WHERE order_id=? AND ${gate.sql}`
      )
      .bind(now(), orderId, ...gate.values),
    ...releaseOrderHoldsStmts(db, orderId, gate),
    db
      .prepare(
        `UPDATE discounts SET usage_count=usage_count-(SELECT COUNT(*) FROM discount_usage WHERE order_id=? AND discount_id=discounts.id) WHERE id IN(SELECT discount_id FROM discount_usage WHERE order_id=?) AND ${gate.sql}`
      )
      .bind(orderId, orderId, ...gate.values),
    db
      .prepare(`DELETE FROM discount_usage WHERE order_id=? AND ${gate.sql}`)
      .bind(orderId, ...gate.values),
  ]);
  return (result[0]?.meta.changes ?? 0) > 0;
}

export async function markOrderPaid(
  db: D1Database,
  sessionId: string,
  data: Record<string, unknown>,
  provider?: PaymentProvider
) {
  const order = await findOrderBySession(db, sessionId);
  if (!order || !['pending_payment', 'canceled'].includes(order.status)) return;
  const metadata = checkoutMetadataSchema.parse(data.metadata ?? {});
  if (metadata.order_id && metadata.order_id !== order.id)
    throw new Error('Webhook order mismatch');
  const amountTotal = typeof data.amount_total === 'number' ? data.amount_total : 0;
  if (amountTotal < order.total_cents || !Number.isSafeInteger(amountTotal))
    throw new Error('Webhook amount below expected total');
  if (
    typeof data.currency !== 'string' ||
    data.currency.toUpperCase() !== order.currency.toUpperCase()
  )
    throw new Error('Webhook currency mismatch');
  const pi = typeof data.payment_intent === 'string' ? data.payment_intent : null;
  if (
    data.payment_status === 'no_payment_required' &&
    (amountTotal !== 0 || order.total_cents !== 0 || pi !== null || data.mode !== 'payment')
  )
    throw new Error('Invalid no-payment-required Checkout Session');
  const shipping = shippingDetailsSchema.safeParse(data.collected_information);
  const address = shipping.success ? shipping.data.shipping_details : undefined;
  const selected = await db
    .prepare('SELECT shipping_country FROM orders WHERE id = ?')
    .bind(order.id)
    .first<{ shipping_country: string | null }>();
  if (selected?.shipping_country && !address)
    throw new Error('Webhook shipping address missing or invalid');
  if (
    address?.address.country &&
    selected?.shipping_country &&
    address.address.country !== selected.shipping_country
  )
    throw new Error('Webhook shipping country mismatch');
  const transition = id(),
    at = now();
  const gate = 'EXISTS (SELECT 1 FROM orders WHERE id = ? AND transition_id = ?)';
  // The claim checks current stock/holds inside the same transaction as recovery and sale.
  const statements = [
    db
      .prepare(
        `UPDATE orders SET status = 'paid', payment_status = CASE WHEN payment_status='disputed' THEN 'disputed' WHEN EXISTS(SELECT 1 FROM refunds WHERE order_id=orders.id AND status='succeeded') THEN 'partially_refunded' ELSE 'paid' END, transition_id = ?, stripe_payment_intent_id = ?, tax_cents = CASE WHEN EXISTS(SELECT 1 FROM checkout_intents WHERE order_id=orders.id) THEN tax_cents ELSE ? END, total_cents = ?, shipping_name = COALESCE(?,shipping_name), shipping_address_json = COALESCE(?,shipping_address_json), updated_at = ?
    WHERE id = ? AND status IN ('pending_payment','canceled') AND payment_status IN ('unpaid','failed','partially_refunded','disputed')
    AND (total_cents=0 OR COALESCE((SELECT SUM(amount_cents) FROM refunds WHERE order_id=orders.id AND status='succeeded'),0)<total_cents)
    AND NOT EXISTS(SELECT 1 FROM checkout_intents ci WHERE ci.order_id=orders.id AND (ci.cancel_requested=1 OR ci.superseded_by IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM checkout_intents ci WHERE ci.order_id=orders.id AND ci.allocation_id IS NULL AND (ci.quote_confirmed_at IS NULL OR EXISTS(SELECT 1 FROM order_items i LEFT JOIN variants v ON v.sku=i.sku LEFT JOIN products p ON p.id=v.product_id WHERE i.order_id=orders.id AND (v.status IS NOT 'active' OR p.status IS NOT 'active')) OR EXISTS(SELECT 1 FROM discounts d WHERE d.id=orders.discount_id AND (d.status!='active' OR d.starts_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR d.expires_at<strftime('%Y-%m-%dT%H:%M:%fZ','now')))))
    AND orders.currency=COALESCE((SELECT value FROM settings WHERE key='currency'),'USD')
    AND NOT EXISTS (SELECT 1 FROM refunds WHERE order_id = orders.id AND purpose='late_payment' AND status NOT IN ('failed','canceled'))
    AND NOT EXISTS (SELECT 1 FROM outbox WHERE id='expired-free-'||orders.id)
    AND (orders.discount_id IS NULL OR EXISTS (
      SELECT 1 FROM discounts d WHERE d.id=orders.discount_id AND d.value>=0 AND (d.type!='percentage' OR d.value<=100)
      AND (EXISTS(SELECT 1 FROM discount_usage WHERE order_id=orders.id AND discount_id=d.id)
        OR ((d.usage_limit IS NULL OR d.usage_count<d.usage_limit)
          AND (SELECT COUNT(*) FROM discount_usage WHERE discount_id=d.id AND customer_email=orders.customer_email)<d.usage_per_customer))))
    AND NOT EXISTS (SELECT 1 FROM order_items i LEFT JOIN stock s ON s.sku = i.sku LEFT JOIN variants v ON v.sku = i.sku
      WHERE i.order_id = orders.id AND (s.sku IS NULL OR (v.continue_selling = 0 AND s.on_hand - s.reserved < i.qty - COALESCE((SELECT SUM(qty) FROM reservations WHERE order_id = orders.id AND sku = i.sku AND status = 'active'),0))))`
      )
      .bind(
        transition,
        pi,
        amountTotal - order.total_cents,
        amountTotal,
        address?.name ?? null,
        address ? JSON.stringify(address.address) : null,
        at,
        order.id
      ),
  ];
  // Reclaim only when this transaction won and the original coupon claim was released.
  statements.push(
    db
      .prepare(
        `UPDATE discounts SET usage_count=usage_count+1 WHERE id=(SELECT discount_id FROM orders WHERE id=?) AND NOT EXISTS(SELECT 1 FROM discount_usage WHERE order_id=?) AND ${gate}`
      )
      .bind(order.id, order.id, order.id, transition),
    db
      .prepare(
        `INSERT INTO discount_usage(id,discount_id,order_id,customer_email,amount_cents,created_at) SELECT ?,discount_id,id,customer_email,discount_cents,? FROM orders WHERE id=? AND discount_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM discount_usage WHERE order_id=orders.id) AND ${gate}`
      )
      .bind(id(), at, order.id, order.id, transition)
  );
  // Set-based commitment (Phase 2): the same six operations the old
  // per-item loop performed — top-up reservations for shortfalls, their
  // stock/ledger effects, sale ledger, stock commitment, reservation
  // commitment — expressed over the order's reservations as a set. Every
  // statement keeps the transition gate, ordering is preserved (sale and
  // stock sums read status='active' before the commit update), and
  // recovered reservations are included, never an earlier snapshot.
  const activeSum = `COALESCE((SELECT SUM(r.qty) FROM reservations r WHERE r.order_id = i.order_id AND r.sku = i.sku AND r.status = 'active'), 0)`;
  statements.push(
    db
      .prepare(
        `INSERT INTO reservations (id, order_id, sku, qty, expires_at, created_at)
         SELECT 'recovery-' || i.id, i.order_id, i.sku, i.qty - ${activeSum}, ?, ? FROM order_items i
         WHERE i.order_id = ? AND i.qty > ${activeSum} AND ${gate}`
      )
      .bind(at, at, order.id, order.id, transition),
    db
      .prepare(
        `UPDATE stock SET reserved = reserved + COALESCE((SELECT SUM(qty) FROM reservations WHERE order_id = ? AND sku = stock.sku AND status = 'active' AND id LIKE 'recovery-%'), 0), updated_at = ?
         WHERE sku IN (SELECT sku FROM order_items WHERE order_id = ?) AND ${gate}`
      )
      .bind(order.id, at, order.id, order.id, transition),
    db
      .prepare(
        `INSERT INTO stock_ledger (id, sku, delta_reserved, reason, ref_type, ref_id, created_at)
         SELECT 'reserve-' || id, sku, qty, 'reserve', 'reservation', id, ? FROM reservations
         WHERE order_id = ? AND status = 'active' AND id LIKE 'recovery-%' AND ${gate}`
      )
      .bind(at, order.id, order.id, transition),
    db
      .prepare(
        `INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, ref_type, ref_id, created_at)
         SELECT 'sale-' || id, sku, -qty, -qty, 'sale', 'reservation', id, ? FROM reservations WHERE order_id = ? AND status = 'active' AND ${gate}`
      )
      .bind(at, order.id, order.id, transition),
    db
      .prepare(
        `UPDATE stock SET on_hand = on_hand - COALESCE((SELECT SUM(qty) FROM reservations WHERE order_id = ? AND sku = stock.sku AND status = 'active'), 0), reserved = reserved - COALESCE((SELECT SUM(qty) FROM reservations WHERE order_id = ? AND sku = stock.sku AND status = 'active'), 0), updated_at = ?
         WHERE sku IN (SELECT sku FROM order_items WHERE order_id = ?) AND ${gate}`
      )
      .bind(order.id, order.id, at, order.id, order.id, transition),
    db
      .prepare(
        `UPDATE reservations SET status = 'committed' WHERE order_id = ? AND status = 'active' AND ${gate}`
      )
      .bind(order.id, order.id, transition)
  );
  statements.push(
    db
      .prepare(
        `INSERT INTO settings (key,value,updated_at) SELECT 'currency_locked','1',? WHERE ${gate} ON CONFLICT(key) DO UPDATE SET value='1',updated_at=excluded.updated_at`
      )
      .bind(at, order.id, transition)
  );
  statements.push(
    emailStatement(
      db,
      `receipt-${order.id}`,
      {
        to: order.customer_email,
        subject: `Order ${order.number} confirmed`,
        text: `Thank you. Order ${order.number} is confirmed and paid (${order.currency} ${(amountTotal / 100).toFixed(2)}). We will email you when it ships.`,
        html: `<p>Order <strong>${order.number}</strong> is confirmed and paid.</p>`,
      },
      { sql: gate, values: [order.id, transition] }
    )
  );
  // A cart edited after approval stays open with the purchased quantities removed.
  const linkedCart = (revision: 'IS' | 'IS NOT') =>
    `carts.status='open' AND EXISTS(SELECT 1 FROM checkout_intents ci WHERE ci.order_id=? AND ci.cart_id=carts.id AND ci.id=carts.active_checkout_id AND ci.cart_revision ${revision} carts.revision)`;
  const purchased = `(SELECT COALESCE(SUM(i.qty),0) FROM order_items i WHERE i.order_id=? AND i.sku=cart_items.sku)`;
  const editedLines = `cart_id IN (SELECT id FROM carts WHERE ${linkedCart('IS NOT')})`;
  statements.push(
    db
      .prepare(
        `UPDATE carts SET status='converted',updated_at=? WHERE ${linkedCart('IS')} AND ${gate}`
      )
      .bind(at, order.id, order.id, transition),
    db
      .prepare(`DELETE FROM cart_items WHERE ${editedLines} AND qty<=${purchased} AND ${gate}`)
      .bind(order.id, order.id, order.id, transition),
    db
      .prepare(
        `UPDATE cart_items SET qty=qty-${purchased} WHERE ${editedLines} AND ${purchased}>0 AND ${gate}`
      )
      .bind(order.id, order.id, order.id, order.id, transition),
    db
      .prepare(
        `UPDATE carts SET active_checkout_id=NULL,revision=revision+1,updated_at=? WHERE ${linkedCart('IS NOT')} AND ${gate}`
      )
      .bind(at, order.id, order.id, transition)
  );
  statements.push(
    db
      .prepare(
        `UPDATE checkout_intents SET payment_state='finalized',payment_next_at=NULL,updated_at=? WHERE order_id=? AND ${gate}`
      )
      .bind(at, order.id, order.id, transition)
  );
  // Capture why this transaction rejected recovery before another request changes settings.
  statements.push(
    db
      .prepare(
        "SELECT CASE WHEN currency!=COALESCE((SELECT value FROM settings WHERE key='currency'),'USD') THEN 'currency_changed' ELSE 'capacity_unavailable' END AS reason FROM orders WHERE id=?"
      )
      .bind(order.id)
  );
  const result = await commitWithEmails(db, statements, [`receipt-${order.id}`]);
  if ((result[0]?.meta.changes ?? 0) > 0) {
    const { broadcastAdminRealtime } = await import('./realtime');
    await broadcastAdminRealtime('order.paid', { sessionId, at: now() });
    return;
  }
  const recoveryReason = (
    result.at(-1)!.results[0] as { reason: 'currency_changed' | 'capacity_unavailable' }
  ).reason;
  const current = await db
    .prepare('SELECT status, payment_status FROM orders WHERE id = ?')
    .bind(order.id)
    .first<{ status: string; payment_status: string }>();
  if (current && !['pending_payment', 'canceled'].includes(current.status)) return;
  if (await compensateRefundedCheckout(db, order.id, { sessionId, amountCents: amountTotal }))
    return;
  if (amountTotal === 0) {
    await cancelOrderById(db, order.id, { expiredFree: true, recoveryReason });
    return;
  }
  // A losing transition is re-read. Only unpaid, genuinely unfulfillable orders need recovery.
  await db
    .prepare(
      "UPDATE orders SET stripe_payment_intent_id = ?, total_cents = ?, updated_at = ? WHERE id = ? AND payment_status IN ('unpaid','failed')"
    )
    .bind(pi, amountTotal, at, order.id)
    .run();
  const recovery = await requestRefund(db, provider, {
    orderId: order.id,
    amountCents: amountTotal,
    requestId: `late-${order.id}`,
    purpose: 'late_payment',
    recoveryReason,
  });
  if (!recovery.ok) throw new Error('Payment recovery remains unresolved');
}

/** Cancel a pending order by ID and release its holds (e.g. Stripe session creation failed). */
export async function cancelOrderById(
  db: D1Database,
  orderId: string,
  options: {
    expiredFree?: boolean;
    recoveryReason?: 'currency_changed' | 'capacity_unavailable';
  } = {}
) {
  const transition = id();
  const gate = 'EXISTS (SELECT 1 FROM orders WHERE id = ? AND transition_id = ?)';
  const cancellationText =
    options.recoveryReason === 'currency_changed'
      ? 'Your checkout could not be completed because the store changed currency. No payment was collected. Please place a new order.'
      : 'Your checkout could not be completed because its stock or discount capacity is no longer available. No payment was collected. Please place a new order.';
  await commitWithEmails(
    db,
    [
      ...cancelOrdersStatements(
        db,
        { sql: 'id=?', values: [orderId] },
        transition,
        options.expiredFree
      ),
      ...(options.expiredFree
        ? [
            emailStatement(
              db,
              `expired-free-${orderId}`,
              {
                to: (await db
                  .prepare('SELECT customer_email FROM orders WHERE id=?')
                  .bind(orderId)
                  .first<{ customer_email: string }>())!.customer_email,
                subject: 'Checkout could not be completed',
                text: cancellationText,
                html: `<p>${cancellationText}</p>`,
              },
              { sql: gate, values: [orderId, transition] }
            ),
          ]
        : []),
    ],
    options.expiredFree ? [`expired-free-${orderId}`] : []
  );
}

async function cancelPendingOrder(db: D1Database, sessionId: string) {
  const order = await findOrderBySession(db, sessionId);
  if (!order) return;
  await cancelOrderById(db, order.id);
}

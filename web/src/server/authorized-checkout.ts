import { sha256Hex } from '../lib/hash';
import { shippingAddressSchema } from '../schemas/checkout';
import { loadIntent, type CheckoutIntentRow } from './checkout-intents';
import { acquireCheckoutPermit, type AdmissionStub } from './checkout-admission';
import {
  CheckoutError,
  markOrderPaid,
  ensureSessionAttached,
  compensateRefundedCheckout,
} from './checkout';
import { reservationStatementsSetBased, releaseOrderHoldsStmts } from './inventory';
import { requestRefund } from './refunds';
import { commitWithEmails, emailStatement, enqueueJob } from './email';
import type { PaymentProvider, PaymentIntentDetails, StripeSessionLite } from './payments';
import {
  recoveryContext,
  authorizationDue,
  authorizationAlertDue,
  authorizationAlertId,
  type RecoveryContext,
} from './recovery-eligibility';

const now = () => new Date().toISOString();
const later = () => new Date(Date.now() + 60_000).toISOString();
// Stripe may prune idempotency keys after 24 hours. Never replay a creation
// operation after 23 hours; retrieval and manual reconciliation remain available.
const OPERATION_HORIZON = 23 * 60 * 60_000;
export type ReviewQuote = {
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
};

export async function recordAuthorizedEvent(
  db: D1Database,
  type: string,
  data: Record<string, unknown>
): Promise<boolean> {
  if (!type.startsWith('checkout.session.') && !type.startsWith('payment_intent.')) return false;
  const metadata = data.metadata as { attempt_id?: string; order_id?: string } | undefined;
  const row = await db
    .prepare(
      `SELECT id,payment_state FROM checkout_intents WHERE flow='manual_capture' AND ((id=? AND order_id=?) OR stripe_session_id=? OR payment_intent_id=?) LIMIT 1`
    )
    .bind(
      metadata?.attempt_id ?? '',
      metadata?.order_id ?? '',
      type.startsWith('checkout.session.') ? String(data.id) : '',
      type.startsWith('payment_intent.') ? String(data.id) : ''
    )
    .first<{ id: string; payment_state: string }>();
  if (!row) return false;
  if (['finalized', 'canceled'].includes(row.payment_state)) return true;
  const pi = type.startsWith('payment_intent.')
    ? String(data.id)
    : typeof data.payment_intent === 'string'
      ? data.payment_intent
      : null;
  await db.batch([
    db
      .prepare(
        'INSERT INTO batch_guard SELECT 1 WHERE EXISTS(SELECT 1 FROM checkout_intents WHERE id=? AND payment_intent_id IS NOT NULL AND ? IS NOT NULL AND payment_intent_id!=?)'
      )
      .bind(row.id, pi, pi),
    db
      .prepare(
        `UPDATE checkout_intents SET payment_intent_id=COALESCE(payment_intent_id,?),cancel_requested=CASE WHEN ? IN ('checkout.session.expired','checkout.session.async_payment_failed') THEN 1 ELSE cancel_requested END,payment_next_at=?,updated_at=? WHERE id=? AND payment_state NOT IN ('finalized','canceled')`
      )
      .bind(pi, type, now(), now(), row.id),
    db
      .prepare(
        'UPDATE orders SET stripe_payment_intent_id=COALESCE(stripe_payment_intent_id,?) WHERE id=(SELECT order_id FROM checkout_intents WHERE id=?)'
      )
      .bind(pi, row.id),
  ]);
  if (type.startsWith('checkout.session.')) await ensureSessionAttached(db, String(data.id), data);
  await enqueueJob({ type: 'checkout.recover', intentId: row.id });
  return true;
}

function identity(intent: CheckoutIntentRow, session: StripeSessionLite) {
  return (
    session.id === intent.stripe_session_id &&
    session.metadata?.order_id === intent.order_id &&
    session.metadata?.attempt_id === intent.id
  );
}

/** Freeze Stripe's complete breakdown before exposing the payment URL. */
export async function prepareReview(
  db: D1Database,
  provider: PaymentProvider,
  intent: CheckoutIntentRow,
  deadline: number
): Promise<ReviewQuote> {
  if (intent.quote_json) return JSON.parse(intent.quote_json) as ReviewQuote;
  if (!intent.stripe_session_id || !provider.retrieveCheckoutSession)
    throw new CheckoutError('Payment review is not ready', 503, 'DEPENDENCY');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CheckoutError('Payment review timed out; retry', 503, 'DEPENDENCY');
  const session = await provider.retrieveCheckoutSession(intent.stripe_session_id, {
    timeoutMs: Math.min(10_000, remaining),
  });
  const payload = JSON.parse(intent.provider_payload_json) as { automaticTax?: boolean };
  if (
    !session ||
    !identity(intent, session) ||
    session.status !== 'open' ||
    session.amount_total === null ||
    (payload.automaticTax && session.automaticTaxStatus !== 'complete')
  )
    throw new CheckoutError('Payment review is not ready; retry', 503, 'DEPENDENCY');
  const order = await db
    .prepare('SELECT subtotal_cents,discount_cents,shipping_cents,currency FROM orders WHERE id=?')
    .bind(intent.order_id)
    .first<{
      subtotal_cents: number;
      discount_cents: number;
      shipping_cents: number;
      currency: string;
    }>();
  if (!order) throw new CheckoutError('Checkout not found', 404, 'NOT_FOUND');
  const quote: ReviewQuote = {
    subtotalCents: session.subtotalCents ?? -1,
    discountCents: session.discountCents ?? -1,
    shippingCents: session.shippingCents ?? -1,
    taxCents: session.taxCents ?? -1,
    totalCents: session.amount_total,
    currency: session.currency.toUpperCase(),
  };
  if (
    Object.values(quote).some(
      (v) => typeof v === 'number' && (!Number.isSafeInteger(v) || v < 0)
    ) ||
    quote.currency !== order.currency ||
    quote.subtotalCents !== order.subtotal_cents ||
    quote.discountCents !== order.discount_cents ||
    quote.shippingCents !== order.shipping_cents ||
    quote.totalCents !==
      quote.subtotalCents - quote.discountCents + quote.shippingCents + quote.taxCents
  )
    throw new CheckoutError(
      'The payment total changed. Review a new checkout.',
      409,
      'STALE_QUOTE'
    );
  const json = JSON.stringify(quote),
    hash = await sha256Hex(json);
  await db.batch([
    db
      .prepare(
        `INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM checkout_intents WHERE id=? AND state='ready' AND cancel_requested=0 AND superseded_by IS NULL AND (quote_json IS NULL OR quote_json=?))`
      )
      .bind(intent.id, json),
    db
      .prepare('UPDATE checkout_intents SET quote_json=?,quote_hash=?,updated_at=? WHERE id=?')
      .bind(json, hash, now(), intent.id),
    db
      .prepare(
        "UPDATE orders SET tax_cents=?,total_cents=?,shipping_name=?,shipping_address_json=?,updated_at=? WHERE id=? AND status='pending_payment'"
      )
      .bind(
        quote.taxCents,
        quote.totalCents,
        shippingAddressSchema.parse(JSON.parse(intent.shipping_address_json!)).name,
        intent.shipping_address_json,
        now(),
        intent.order_id
      ),
  ]);
  return quote;
}

export async function confirmReview(
  db: D1Database,
  intentId: string,
  quoteHash: string
): Promise<string> {
  const result = await db
    .prepare(
      `UPDATE checkout_intents SET quote_confirmed_at=COALESCE(quote_confirmed_at,?),updated_at=? WHERE id=? AND flow='manual_capture' AND state='ready' AND cancel_requested=0 AND superseded_by IS NULL AND quote_hash=? AND session_expires_at>? AND EXISTS(SELECT 1 FROM orders WHERE id=checkout_intents.order_id AND status='pending_payment') AND (cart_id IS NULL OR EXISTS(SELECT 1 FROM carts WHERE id=cart_id AND revision=cart_revision AND active_checkout_id=checkout_intents.id AND status='open'))`
    )
    .bind(now(), now(), intentId, quoteHash, now())
    .run();
  if (!(result.meta.changes ?? 0))
    throw new CheckoutError(
      'Checkout changed or expired. Review your order again.',
      409,
      'CONFLICT'
    );
  return (await loadIntent(db, intentId))!.checkout_url!;
}

type PaymentClaim = { id: string; token: string; fence: number };
function guard(db: D1Database, c: PaymentClaim) {
  return db
    .prepare(
      `INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM checkout_intents WHERE id=? AND payment_claim_token=? AND payment_fencing=? AND payment_claim_expires_at>?)`
    )
    .bind(c.id, c.token, c.fence, now());
}

async function requestCancellation(db: D1Database, claim: PaymentClaim) {
  await db.batch([
    guard(db, claim),
    db
      .prepare(
        'UPDATE checkout_intents SET cancel_requested=1,cancellation_attempted_at=COALESCE(cancellation_attempted_at,?),payment_next_at=?,updated_at=? WHERE id=?'
      )
      .bind(now(), now(), now(), claim.id),
  ]);
}

async function cancelAuthorizationLocally(
  db: D1Database,
  intent: CheckoutIntentRow,
  claim: PaymentClaim,
  notify = true
) {
  const gate = {
    sql: "EXISTS(SELECT 1 FROM checkout_intents WHERE id=? AND payment_claim_token=? AND payment_fencing=? AND payment_state='canceled')",
    values: [intent.id, claim.token, claim.fence],
  };
  const order = await db
    .prepare('SELECT customer_email,number FROM orders WHERE id=?')
    .bind(intent.order_id)
    .first<{ customer_email: string; number: string }>();
  const emailed = notify && order && order.customer_email !== 'deleted@invalid';
  await commitWithEmails(
    db,
    [
      guard(db, claim),
      db
        .prepare(
          "UPDATE checkout_intents SET payment_state='canceled',state='canceled',payment_next_at=NULL,updated_at=? WHERE id=?"
        )
        .bind(now(), intent.id),
      ...releaseOrderHoldsStmts(db, intent.order_id, gate),
      db
        .prepare(
          `UPDATE discounts SET usage_count=usage_count-(SELECT COUNT(*) FROM discount_usage WHERE order_id=? AND discount_id=discounts.id) WHERE id IN(SELECT discount_id FROM discount_usage WHERE order_id=?) AND ${gate.sql}`
        )
        .bind(intent.order_id, intent.order_id, ...gate.values),
      db
        .prepare(`DELETE FROM discount_usage WHERE order_id=? AND ${gate.sql}`)
        .bind(intent.order_id, ...gate.values),
      db
        .prepare(
          "UPDATE orders SET status='canceled',updated_at=? WHERE id=? AND status='pending_payment' AND payment_status IN ('unpaid','failed')"
        )
        .bind(now(), intent.order_id),
      ...(emailed
        ? [
            emailStatement(
              db,
              `authorization-canceled-${intent.id}`,
              {
                to: order.customer_email,
                subject: `Order ${order.number} could not be completed`,
                text: 'This checkout was canceled or could not be allocated. No sale was completed. Your payment provider may take time to release an authorization. Please place a new order if needed.',
                html: '<p>This checkout was canceled or could not be allocated. No sale was completed. Your provider may take time to release an authorization.</p>',
              },
              gate
            ),
          ]
        : []),
    ],
    emailed ? [`authorization-canceled-${intent.id}`] : []
  );
}

function assertPayment(intent: CheckoutIntentRow, pi: PaymentIntentDetails, quote: ReviewQuote) {
  if (
    pi.id !== intent.payment_intent_id ||
    pi.metadata.order_id !== intent.order_id ||
    pi.metadata.attempt_id !== intent.id ||
    pi.currency.toUpperCase() !== quote.currency ||
    pi.amount !== quote.totalCents
  )
    throw new CheckoutError(
      'Authorized payment does not match the confirmed order',
      409,
      'PAYMENT_MISMATCH'
    );
}

async function allocate(db: D1Database, intent: CheckoutIntentRow, claim: PaymentClaim) {
  const items = await db
    .prepare('SELECT sku,qty FROM order_items WHERE order_id=?')
    .bind(intent.order_id)
    .all<{ sku: string; qty: number }>();
  const allocation = crypto.randomUUID(),
    at = now();
  const { stmts } = reservationStatementsSetBased(db, items.results, {
    orderId: intent.order_id,
    holdMinutes: 1440,
  });
  await db.batch([
    guard(db, claim),
    db
      .prepare(
        `INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM checkout_intents ci JOIN orders o ON o.id=ci.order_id WHERE ci.id=? AND ci.cancel_requested=0 AND ci.superseded_by IS NULL AND ci.quote_confirmed_at IS NOT NULL AND ci.allocation_id IS NULL AND o.status='pending_payment' AND o.currency=COALESCE((SELECT value FROM settings WHERE key='currency'),'USD') AND (ci.cart_id IS NULL OR EXISTS(SELECT 1 FROM carts WHERE id=ci.cart_id AND active_checkout_id=ci.id)) AND NOT EXISTS(SELECT 1 FROM order_items i LEFT JOIN variants v ON v.sku=i.sku LEFT JOIN products p ON p.id=v.product_id WHERE i.order_id=o.id AND (v.status IS NOT 'active' OR p.status IS NOT 'active')) AND (o.discount_id IS NULL OR EXISTS(SELECT 1 FROM discounts d WHERE d.id=o.discount_id AND d.status='active' AND d.value>=0 AND (d.starts_at IS NULL OR d.starts_at<=?) AND (d.expires_at IS NULL OR d.expires_at>=?) AND (d.type!='percentage' OR d.value<=100) AND (d.usage_limit IS NULL OR d.usage_count<d.usage_limit) AND (SELECT COUNT(*) FROM discount_usage WHERE discount_id=d.id AND lower(customer_email)=lower(o.customer_email))<d.usage_per_customer)))`
      )
      .bind(intent.id, at, at),
    ...stmts,
    db
      .prepare(
        'UPDATE discounts SET usage_count=usage_count+1 WHERE id=(SELECT discount_id FROM orders WHERE id=?)'
      )
      .bind(intent.order_id),
    db
      .prepare(
        'INSERT INTO discount_usage(id,discount_id,order_id,customer_email,amount_cents,created_at) SELECT ?,discount_id,id,customer_email,discount_cents,? FROM orders WHERE id=? AND discount_id IS NOT NULL'
      )
      .bind(crypto.randomUUID(), at, intent.order_id),
    db
      .prepare(
        "UPDATE checkout_intents SET allocation_id=?,payment_state='allocated',payment_next_at=?,updated_at=? WHERE id=?"
      )
      .bind(allocation, at, at, intent.id),
  ]);
}

function paidSession(intent: CheckoutIntentRow, quote: ReviewQuote) {
  const a = shippingAddressSchema.parse(JSON.parse(intent.shipping_address_json!));
  return {
    id: intent.stripe_session_id!,
    mode: 'payment',
    payment_status: quote.totalCents === 0 ? 'no_payment_required' : 'paid',
    amount_total: quote.totalCents,
    currency: quote.currency,
    payment_intent: intent.payment_intent_id,
    metadata: { order_id: intent.order_id, attempt_id: intent.id },
    collected_information: {
      shipping_details: {
        name: a.name,
        address: {
          line1: a.line1,
          line2: a.line2,
          city: a.city,
          state: a.state,
          postal_code: a.postalCode,
          country: a.country,
        },
      },
    },
  };
}

/** One durable, fenced recovery operation; provider observations precede POST retries. */
export async function runAuthorizedCheckout(
  db: D1Database,
  provider: PaymentProvider,
  intentId: string,
  admission: { getByName(name: string): AdmissionStub } | undefined,
  deadline = Date.now() + 30_000
): Promise<void> {
  const permit = await acquireCheckoutPermit(admission, 'settle');
  if (permit.kind !== 'acquired') {
    const delaySeconds =
      permit.kind === 'busy'
        ? Math.min(60, permit.retryAfterSeconds + Math.floor(Math.random() * 5))
        : 60;
    await db
      .prepare(
        "UPDATE checkout_intents SET payment_next_at=? WHERE id=? AND payment_state NOT IN ('finalized','canceled')"
      )
      .bind(new Date(Date.now() + delaySeconds * 1000).toISOString(), intentId)
      .run();
    if (permit.kind === 'busy')
      await enqueueJob({ type: 'checkout.recover', intentId }, { delaySeconds });
    return;
  }
  let claim: PaymentClaim | undefined;
  try {
    let intent = await loadIntent(db, intentId);
    if (
      !intent ||
      intent.flow !== 'manual_capture' ||
      ['finalized', 'canceled'].includes(intent.payment_state)
    )
      return;
    const token = crypto.randomUUID();
    const claimed = await db
      .prepare(
        `UPDATE checkout_intents SET payment_claim_token=?,payment_claim_expires_at=?,payment_fencing=payment_fencing+1 WHERE id=? AND payment_state NOT IN ('finalized','canceled') AND (payment_claim_expires_at IS NULL OR payment_claim_expires_at<?)`
      )
      .bind(token, new Date(Date.now() + 120_000).toISOString(), intentId, now())
      .run();
    if (!(claimed.meta.changes ?? 0)) return;
    intent = (await loadIntent(db, intentId))!;
    claim = { id: intentId, token, fence: intent.payment_fencing };
    const options = () => {
      const remaining = deadline - Date.now();
      if (remaining < 5000) throw Error('Payment operation deadline exceeded');
      return { timeoutMs: Math.min(10_000, remaining) };
    };
    if (!intent.stripe_session_id) {
      const creating =
        intent.state === 'session_creating' && (intent.claim_expires_at ?? '') > now();
      const payable =
        intent.provider_step === 'session' && Date.parse(intent.session_expires_at) > Date.now();
      if ((intent.cancel_requested || intent.superseded_by) && !creating && !payable) {
        await cancelAuthorizationLocally(db, intent, claim, !intent.superseded_by);
        return;
      }
      // Session creation may already be in flight. Initiation recovery retains
      // its idempotency identity and the provider scan can attach a late result.
      await db
        .prepare(
          'UPDATE checkout_intents SET payment_next_at=? WHERE id=? AND payment_claim_token=?'
        )
        .bind(later(), intentId, token)
        .run();
      return;
    }
    if (!provider.retrieveCheckoutSession) throw Error('Session retrieval unavailable');
    const session = await provider.retrieveCheckoutSession(intent.stripe_session_id, options());
    if (!session || !identity(intent, session)) throw Error('Payment Session unresolved');
    if (session.payment_intent && session.payment_intent !== intent.payment_intent_id) {
      await db.batch([
        guard(db, claim),
        db
          .prepare(
            'INSERT INTO batch_guard SELECT 1 WHERE EXISTS(SELECT 1 FROM checkout_intents WHERE id=? AND payment_intent_id IS NOT NULL AND payment_intent_id!=?)'
          )
          .bind(intentId, session.payment_intent),
        db
          .prepare('UPDATE checkout_intents SET payment_intent_id=? WHERE id=?')
          .bind(session.payment_intent, intentId),
        db
          .prepare('UPDATE orders SET stripe_payment_intent_id=? WHERE id=?')
          .bind(session.payment_intent, intent.order_id),
      ]);
      intent = (await loadIntent(db, intentId))!;
    }
    let cancel = Boolean(
      intent.cancel_requested ||
      intent.superseded_by ||
      !intent.quote_confirmed_at ||
      session.status === 'expired' ||
      (session.status === 'open' && Date.parse(intent.session_expires_at) <= Date.now())
    );
    if (!intent.payment_intent_id) {
      if (
        cancel &&
        session.status === 'complete' &&
        session.payment_status === 'no_payment_required' &&
        session.amount_total === 0
      ) {
        await cancelAuthorizationLocally(db, intent, claim);
        return;
      }
      if (
        session.payment_status === 'no_payment_required' &&
        session.status === 'complete' &&
        session.amount_total === 0 &&
        intent.quote_json &&
        !cancel
      ) {
        const quote = JSON.parse(intent.quote_json) as ReviewQuote;
        if (quote.totalCents !== 0 || session.currency.toUpperCase() !== quote.currency)
          throw Error('Free Session mismatch');
        await markOrderPaid(db, session.id, paidSession(intent, quote), provider);
        await db
          .prepare(
            "UPDATE checkout_intents SET payment_state=CASE WHEN EXISTS(SELECT 1 FROM orders WHERE id=order_id AND payment_status='paid') THEN 'finalized' ELSE 'canceled' END,payment_next_at=NULL WHERE id=? AND payment_claim_token=?"
          )
          .bind(intentId, token)
          .run();
        return;
      }
      if (cancel && session.status === 'open') {
        await requestCancellation(db, claim);
        if (!provider.expireCheckoutSession) throw Error('Session expiration unavailable');
        await provider.expireCheckoutSession(session.id, `expire_${intentId}`, options());
      }
      if (session.status === 'expired' || (cancel && session.status === 'open')) {
        await cancelAuthorizationLocally(db, intent, claim);
        return;
      }
      await db
        .prepare(
          'UPDATE checkout_intents SET payment_next_at=? WHERE id=? AND payment_claim_token=?'
        )
        .bind(later(), intentId, token)
        .run();
      return;
    }
    if (!provider.retrievePaymentIntent) throw Error('Payment retrieval unavailable');
    let pi = await provider.retrievePaymentIntent(intent.payment_intent_id, options());
    const quote = intent.quote_json ? (JSON.parse(intent.quote_json) as ReviewQuote) : null;
    if (!quote) cancel = true;
    if (quote) {
      try {
        assertPayment(intent, pi, quote);
        if (
          session.amount_total !== quote.totalCents ||
          session.currency.toUpperCase() !== quote.currency
        )
          cancel = true;
      } catch {
        console.error(JSON.stringify({ event: 'authorized_payment_mismatch', intentId }));
        cancel = true;
      }
    }
    if (pi.status === 'canceled') {
      await cancelAuthorizationLocally(db, intent, claim);
      return;
    }
    if (pi.status === 'requires_capture') {
      await db.batch([
        guard(db, claim),
        db
          .prepare(
            "UPDATE checkout_intents SET authorized_at=COALESCE(authorized_at,?),authorization_deadline_at=COALESCE(authorization_deadline_at,?),payment_state=CASE WHEN allocation_id IS NULL THEN 'authorized' ELSE payment_state END WHERE id=?"
          )
          .bind(
            now(),
            pi.captureBefore ? new Date(pi.captureBefore * 1000).toISOString() : null,
            intentId
          ),
      ]);
      if (quote && pi.amountCapturable !== quote.totalCents) cancel = true;
      if (!cancel && !intent.allocation_id) {
        try {
          await allocate(db, intent, claim);
        } catch (error) {
          const current = await loadIntent(db, intentId);
          if (current?.payment_claim_token !== token) return;
          // Only a known integrity rejection means allocation failed. A D1
          // transport failure stays uncertain and must not trigger cancellation.
          if (
            !/CHECK|constraint|stock|discount|batch_guard/i.test(
              error instanceof Error ? error.message : ''
            )
          )
            throw error;
          console.warn(JSON.stringify({ event: 'authorized_allocation_rejected', intentId }));
          cancel = true;
        }
        intent = (await loadIntent(db, intentId))!;
      }
      if (intent.cancel_requested || intent.superseded_by) cancel = true;
      if (cancel) {
        await requestCancellation(db, claim);
        if (!provider.cancelPaymentIntent) throw Error('Authorization cancellation unavailable');
        pi = await provider.cancelPaymentIntent(pi.id, `cancel_${intentId}`, options());
        if (pi.status === 'canceled') {
          await cancelAuthorizationLocally(db, intent, claim);
          return;
        }
        throw Error('Cancellation outcome unresolved');
      }
      if (!quote || !intent.allocation_id) throw Error('Payment allocation unresolved');
      if (
        intent.payment_attempted_at &&
        Date.now() - Date.parse(intent.payment_attempted_at) >= OPERATION_HORIZON
      )
        throw Error('Capture creation safety horizon reached');
      if (pi.captureBefore && pi.captureBefore * 1000 <= Date.now() + 10_000)
        throw Error('Authorization deadline requires reconciliation');
      await db.batch([
        guard(db, claim),
        db
          .prepare(
            `INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM checkout_intents WHERE id=? AND cancel_requested=0 AND superseded_by IS NULL AND allocation_id IS NOT NULL)`
          )
          .bind(intentId),
        db
          .prepare(
            "UPDATE checkout_intents SET payment_state='capture_uncertain',payment_attempted_at=COALESCE(payment_attempted_at,?),payment_next_at=?,updated_at=? WHERE id=?"
          )
          .bind(now(), later(), now(), intentId),
      ]);
      if (!provider.capturePaymentIntent) throw Error('Capture unavailable');
      pi = await provider.capturePaymentIntent(
        pi.id,
        quote.totalCents,
        `capture_${intentId}`,
        options()
      );
    }
    if (pi.status === 'succeeded') {
      await db.batch([
        guard(db, claim),
        db
          .prepare(
            "UPDATE checkout_intents SET captured_at=COALESCE(captured_at,?),payment_state='captured' WHERE id=?"
          )
          .bind(now(), intentId),
      ]);
      intent = (await loadIntent(db, intentId))!;
      if (quote) assertPayment(intent, pi, quote);
      if (!quote || pi.amountReceived !== quote.totalCents)
        throw Error('Captured amount mismatch requires reconciliation');
      if (await compensateRefundedCheckout(db, intent.order_id)) return;
      if (
        intent.cancel_requested ||
        intent.superseded_by ||
        !intent.shipping_address_json ||
        !intent.allocation_id
      ) {
        const result = await requestRefund(db, provider, {
          orderId: intent.order_id,
          amountCents: quote.totalCents,
          requestId: `late-${intent.order_id}`,
          purpose: 'late_payment',
          recoveryReason: 'capacity_unavailable',
        });
        if (!result.ok) throw Error('Captured cancellation refund unresolved');
        await db
          .prepare(
            "UPDATE checkout_intents SET payment_state='finalized',payment_next_at=NULL WHERE id=? AND payment_claim_token=?"
          )
          .bind(intentId, token)
          .run();
      } else {
        await markOrderPaid(db, session.id, paidSession(intent, quote), provider);
        await db
          .prepare(
            "UPDATE checkout_intents SET payment_state='finalized',payment_next_at=NULL WHERE id=? AND payment_claim_token=? AND EXISTS(SELECT 1 FROM orders WHERE id=checkout_intents.order_id AND (status NOT IN ('pending_payment','canceled') OR EXISTS(SELECT 1 FROM refunds WHERE order_id=checkout_intents.order_id AND purpose='late_payment')))"
          )
          .bind(intentId, token)
          .run();
      }
      return;
    }
    // Never directly cancel a Checkout-owned PI outside requires_capture.
    if (cancel && session.status === 'open') {
      await requestCancellation(db, claim);
      if (!provider.expireCheckoutSession) throw Error('Session expiration unavailable');
      await provider.expireCheckoutSession(session.id, `expire_${intentId}`, options());
    }
    await db
      .prepare('UPDATE checkout_intents SET payment_next_at=? WHERE id=? AND payment_claim_token=?')
      .bind(later(), intentId, token)
      .run();
    if (intent.allocation_id)
      await enqueueJob({ type: 'checkout.recover', intentId }, { delaySeconds: 60 });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'authorized_checkout_uncertain',
        intentId,
        error: error instanceof Error ? error.name : 'unknown',
      })
    );
    if (claim) {
      const delaySeconds = Math.min(900, 30 * 2 ** Math.min(claim.fence, 5));
      await db
        .prepare(
          "UPDATE checkout_intents SET payment_next_at=?,failure_code='payment_uncertain' WHERE id=? AND payment_claim_token=?"
        )
        .bind(new Date(Date.now() + delaySeconds * 1000).toISOString(), intentId, claim.token)
        .run();
      await enqueueJob({ type: 'checkout.recover', intentId }, { delaySeconds });
    }
  } finally {
    if (claim)
      await db
        .prepare(
          'UPDATE checkout_intents SET payment_claim_token=NULL,payment_claim_expires_at=NULL WHERE id=? AND payment_claim_token=? AND payment_fencing=?'
        )
        .bind(intentId, claim.token, claim.fence)
        .run();
    await permit.release();
  }
}

export async function recoverAuthorizedCheckouts(
  db: D1Database,
  provider: PaymentProvider | null,
  admission: { getByName(name: string): AdmissionStub } | undefined,
  limit = 20,
  dueBefore = now(),
  context?: RecoveryContext
) {
  if (!provider) return 0;
  const captured = context ?? (await recoveryContext(db, dueBefore));
  const due = authorizationDue(captured);
  const rows = await db
    .prepare(
      `SELECT ci.id FROM checkout_intents ci WHERE ${due.sql} ORDER BY ci.payment_next_at,ci.id LIMIT ?`
    )
    .bind(...due.values, limit)
    .all<{ id: string }>();
  let advanced = 0;
  for (const row of rows.results) {
    await runAuthorizedCheckout(db, provider, row.id, admission);
    // A selected row is not progress; only completed or durably deferred work counts.
    const stillDue = await db
      .prepare(`SELECT 1 FROM checkout_intents ci WHERE ci.id=? AND ${due.sql}`)
      .bind(row.id, ...due.values)
      .first();
    if (!stillDue) advanced++;
  }
  const alertDue = authorizationAlertDue(captured);
  const old = await db
    .prepare(
      `SELECT ci.id,ci.authorized_at FROM checkout_intents ci WHERE ${alertDue.sql} ORDER BY ci.authorized_at,ci.id LIMIT 20`
    )
    .bind(...alertDue.values)
    .all<{ id: string; authorized_at: string }>();
  if (old.results.length) {
    const recipients = captured.recipients;
    const alertId = (row: { id: string; authorized_at: string }, to: string) =>
      authorizationAlertId(captured, row.id, row.authorized_at, to);
    console.warn(
      JSON.stringify({
        event: 'authorization_recovery_overdue',
        count: old.results.length,
        oldestAgeSeconds: Math.floor(
          (Date.now() - Date.parse(old.results[0]!.authorized_at)) / 1000
        ),
      })
    );
    await commitWithEmails(
      db,
      old.results.flatMap((row) =>
        recipients.map((to) =>
          emailStatement(db, alertId(row, to), {
            to,
            subject:
              Date.parse(captured.clock) - Date.parse(row.authorized_at) > 15 * 60_000
                ? 'Escalation: authorized checkout remains unresolved'
                : 'Authorized checkout needs recovery',
            text: `Checkout ${row.id} has an unresolved payment operation. Inspect provider state before releasing inventory.`,
            html: '<p>An authorized checkout needs recovery. Inspect provider state before releasing inventory.</p>',
          })
        )
      ),
      old.results.flatMap((row) => recipients.map((to) => alertId(row, to)))
    );
  }
  return advanced + old.results.length;
}

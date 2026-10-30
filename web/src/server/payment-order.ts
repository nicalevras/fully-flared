import type { PaymentProvider } from './payments';

/** `foreign` is true only when Stripe confirmed the PaymentIntent has no Checkout Session. */
export type PaymentOrderLookup = { order: { id: string } | null; foreign: boolean };

/** PaymentIntent events can beat Checkout delivery; resolve the stored session first. */
export async function lookupPaymentOrder(
  db: D1Database,
  pi: string,
  provider?: PaymentProvider
): Promise<PaymentOrderLookup> {
  let order = await db
    .prepare('SELECT id FROM orders WHERE stripe_payment_intent_id=?')
    .bind(pi)
    .first<{ id: string }>();
  if (order || !provider?.findCheckoutSessionIdByPaymentIntent) return { order, foreign: false };
  const session = await provider.findCheckoutSessionIdByPaymentIntent(pi);
  if (!session) return { order: null, foreign: true };
  await db
    .prepare(
      'UPDATE orders SET stripe_payment_intent_id=? WHERE stripe_checkout_session_id=? AND (stripe_payment_intent_id IS NULL OR stripe_payment_intent_id=?)'
    )
    .bind(pi, session, pi)
    .run();
  order = await db
    .prepare('SELECT id FROM orders WHERE stripe_payment_intent_id=?')
    .bind(pi)
    .first<{ id: string }>();
  return { order, foreign: false };
}

export async function resolvePaymentOrder(
  db: D1Database,
  pi: string,
  provider?: PaymentProvider
): Promise<{ id: string } | null> {
  return (await lookupPaymentOrder(db, pi, provider)).order;
}

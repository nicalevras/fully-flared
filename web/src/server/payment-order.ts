import type { PaymentProvider } from './payments';

/** PaymentIntent events can beat Checkout delivery; resolve the stored session first. */
export async function resolvePaymentOrder(
  db: D1Database,
  pi: string,
  provider?: PaymentProvider
): Promise<{ id: string } | null> {
  let order = await db
    .prepare('SELECT id FROM orders WHERE stripe_payment_intent_id=?')
    .bind(pi)
    .first<{ id: string }>();
  if (!order && provider?.findCheckoutSessionIdByPaymentIntent) {
    const session = await provider.findCheckoutSessionIdByPaymentIntent(pi);
    if (session)
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
  }
  return order;
}

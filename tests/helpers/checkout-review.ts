import { ensureCart, addCartLine, cartIdentity } from '../../web/src/server/cart';

export const fixtureShippingAddress = {
  name: 'Fixture',
  line1: '1 Test Street',
  city: 'New York',
  state: 'NY',
  postalCode: '10001',
  country: 'US',
};

export async function checkoutCart(db: D1Database) {
  const { creds } = await ensureCart(db, null);
  await addCartLine(db, creds, 'TEE-1', 1);
  return {
    cartId: creds.id,
    cartRevision: (await cartIdentity(db, creds))!.revision,
    shippingAddress: fixtureShippingAddress,
    cookie: `cart=${creds.id}.${creds.token}`,
  };
}

export async function reviewSession(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT ci.id,ci.order_id,o.subtotal_cents,o.discount_cents,o.shipping_cents,
    o.total_cents,o.currency FROM checkout_intents ci JOIN orders o ON o.id=ci.order_id WHERE ci.stripe_session_id=?`
    )
    .bind(id)
    .first<{
      id: string;
      order_id: string;
      subtotal_cents: number;
      discount_cents: number;
      shipping_cents: number;
      total_cents: number;
      currency: string;
    }>();
  if (!row) return null;
  return {
    id,
    status: 'open',
    payment_status: 'unpaid',
    payment_intent: null,
    url: 'https://stripe.test/fixture',
    amount_total: row.total_cents,
    subtotalCents: row.subtotal_cents,
    discountCents: row.discount_cents,
    shippingCents: row.shipping_cents,
    taxCents: 0,
    currency: row.currency,
    metadata: { order_id: row.order_id, attempt_id: row.id },
  };
}

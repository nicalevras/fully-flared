import { createPendingOrder, type CheckoutIntentInsert } from '../../web/src/server/checkout';
import { reservationStatementsSetBased } from '../../web/src/server/inventory';

/** A manual-capture checkout intent: the only way an order is created. */
export function pendingIntent(overrides: Partial<CheckoutIntentInsert> = {}): CheckoutIntentInsert {
  const id = crypto.randomUUID();
  return {
    id,
    ownerType: 'guest',
    userId: null,
    guestCapabilityHash: 'fixture',
    fingerprint: id,
    sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    payloadFor: async () => ({}),
    ...overrides,
  };
}

/** A pending order whose stock and coupon are already held, as after
 *  allocation but before the authorized payment settles. */
export async function heldOrder(
  db: D1Database,
  input: Parameters<typeof createPendingOrder>[1],
  overrides: Partial<CheckoutIntentInsert> = {}
) {
  const created = await createPendingOrder(db, input, pendingIntent(overrides));
  const items = await db
    .prepare('SELECT sku,qty FROM order_items WHERE order_id=?')
    .bind(created.orderId)
    .all<{ sku: string; qty: number }>();
  const { stmts } = reservationStatementsSetBased(db, items.results, {
    orderId: created.orderId,
    holdMinutes: created.limits.checkout_session_minutes + 10,
  });
  await db.batch([
    ...stmts,
    db
      .prepare(
        'UPDATE discounts SET usage_count=usage_count+1 WHERE id=(SELECT discount_id FROM orders WHERE id=?)'
      )
      .bind(created.orderId),
    db
      .prepare(
        'INSERT INTO discount_usage(id,discount_id,order_id,customer_email,amount_cents,created_at) SELECT ?,discount_id,id,customer_email,discount_cents,? FROM orders WHERE id=? AND discount_id IS NOT NULL'
      )
      .bind(crypto.randomUUID(), new Date().toISOString(), created.orderId),
    db
      .prepare('UPDATE checkout_intents SET quote_confirmed_at=? WHERE order_id=?')
      .bind(new Date().toISOString(), created.orderId),
  ]);
  return created;
}

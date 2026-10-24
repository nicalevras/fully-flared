import { afterAll, beforeAll, expect, it } from 'vitest';
import { deliverStripeEvent } from './helpers/webhook';
import { createTestDb, seedProduct, expectLedgerMatchesCounters } from './helpers/d1';
import { cancelOrderById } from '../web/src/server/checkout';
import type { PaymentProvider } from '../web/src/server/payments';
import { heldOrder } from './helpers/pending-intent';

let db: D1Database;
let dispose: () => Promise<void>;
const provider: PaymentProvider = {
  async createCheckout() {
    return { sessionId: '', url: '' };
  },
  async verifyWebhook(payload) {
    const e = JSON.parse(payload);
    return { ...e, data: e.data.object };
  },
  async refund(_pi, _amount, row) {
    return { id: `re_${row}`, status: 'pending' };
  },
};
beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  await seedProduct(db);
});
afterAll(async () => {
  await dispose();
});
it('requires explicit shipping selection before reserving stock', async () => {
  await expect(
    heldOrder(db, { email: 'shipping@test.com', lines: [{ sku: 'TEE-1', qty: 1 }] })
  ).rejects.toThrow(/shipping/i);
  expect((await expectLedgerMatchesCounters(db, 'TEE-1')).reserved).toBe(0);
});
it('rejects archived parent products through direct checkout', async () => {
  await db.prepare("UPDATE products SET status = 'archived' WHERE id = 'p1'").run();
  try {
    await expect(
      heldOrder(db, {
        email: 'archived@test.com',
        lines: [{ sku: 'TEE-1', qty: 1 }],
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
      })
    ).rejects.toThrow(/active/i);
  } finally {
    await db.prepare("UPDATE products SET status = 'active' WHERE id = 'p1'").run();
  }
});
it('persists Stripe v23 shipping and creates one durable receipt across duplicate payment and expiry', async () => {
  const o = await heldOrder(db, {
    email: 'paid@test.com',
    lines: [{ sku: 'TEE-1', qty: 1 }],
    shippingCountry: 'US',
    shippingRateId: 'test-rate',
  });
  await db
    .prepare('UPDATE orders SET stripe_checkout_session_id = ? WHERE id = ?')
    .bind('cs_remediation', o.orderId)
    .run();
  const data = {
    id: 'cs_remediation',
    payment_status: 'paid',
    payment_intent: 'pi_remediation',
    amount_total: o.totalCents,
    currency: 'usd',
    metadata: { order_id: o.orderId },
    collected_information: {
      shipping_details: {
        name: 'Test Customer',
        address: { line1: '1 Main St', city: 'New York', postal_code: '10001', country: 'US' },
      },
    },
  };
  for (const id of ['evt_remediation1', 'evt_remediation2']) {
    await deliverStripeEvent(
      db,
      provider,
      JSON.stringify({ id, type: 'checkout.session.completed', data: { object: data } }),
      'test'
    );
    await cancelOrderById(db, o.orderId);
  }
  expect(
    await db
      .prepare('SELECT status, shipping_name FROM orders WHERE id = ?')
      .bind(o.orderId)
      .first()
  ).toEqual({ status: 'paid', shipping_name: 'Test Customer' });
  expect(
    (
      await db
        .prepare("SELECT COUNT(*) AS c FROM outbox WHERE payload_json LIKE '%confirmed and paid%'")
        .first<{ c: number }>()
    )?.c
  ).toBe(1);
  await expectLedgerMatchesCounters(db, 'TEE-1');
});
it('rejects edits and deletions of the append-only inventory ledger', async () => {
  await expect(
    db.prepare("UPDATE stock_ledger SET reason = 'damaged' WHERE id = 'seed-ledger'").run()
  ).rejects.toThrow(/append.only/i);
  await expect(
    db.prepare("DELETE FROM stock_ledger WHERE id = 'seed-ledger'").run()
  ).rejects.toThrow(/append.only/i);
});

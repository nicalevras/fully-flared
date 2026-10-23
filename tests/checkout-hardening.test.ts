import { it, expect } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { buildCatalogReadModels } from './helpers/catalog-driver';
import { processCatalogWork } from '../web/src/server/catalog-publisher';
import { readProductDocument } from '../web/src/server/catalog-read';
import { createPendingOrder, cancelOrderById, processInboxEvent } from '../web/src/server/checkout';
import { attachStripeSession } from './helpers/attach-session';
import { rememberProviderSession } from '../web/src/server/checkout-intents';
import { adjustStock } from '../web/src/server/inventory';
import { deliverStripeEvent } from './helpers/webhook';
class Kv {
  map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}
it.each(['incremental', 'full'])(
  'retires renamed product pointers after %s publication',
  async (mode) => {
    const { db, dispose } = await createTestDb(),
      kv = new Kv();
    try {
      await seedProduct(db);
      await buildCatalogReadModels(db, kv);
      await db.prepare("UPDATE products SET slug='renamed',title='New title' WHERE id='p1'").run();
      await db
        .prepare(
          "INSERT INTO redirects(id,from_path,to_path,created_at) VALUES('redirect','/products/tee','/products/renamed','2026')"
        )
        .run();
      if (mode === 'full') await buildCatalogReadModels(db, kv);
      else await processCatalogWork(db, kv);
      const old = await readProductDocument(db, kv, 'tee'),
        fresh = await readProductDocument(db, kv, 'renamed');
      expect(old).toBeNull();
      expect(fresh?.title).toBe('New title');
    } finally {
      await dispose();
    }
  }
);

it('retries disputed late-payment recovery after a won dispute', async () => {
  const { db, dispose } = await createTestDb();
  let refundCalls = 0;
  const provider = {
    async createCheckout() {
      throw Error('not used');
    },
    async verifyWebhook(payload: string) {
      const e = JSON.parse(payload);
      return { id: e.id, type: e.type, data: e.data.object };
    },
    async refund() {
      refundCalls++;
      return { id: 're_probe', status: 'succeeded' };
    },
    async findCheckoutSessionIdByPaymentIntent() {
      return 'cs_probe';
    },
  };
  try {
    await seedProduct(db);
    const o = await createPendingOrder(db, {
      email: 'fixture@example.invalid',
      lines: [{ sku: 'TEE-1', qty: 1 }],
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
    });
    await attachStripeSession(db, o.orderId, 'cs_probe');
    await db
      .prepare(
        "INSERT INTO checkout_intents(id,order_id,owner_type,guest_capability_hash,fingerprint,state,provider_payload_json,coupon_idempotency_key,session_idempotency_key,stripe_session_id,session_expires_at,created_at,updated_at) VALUES('audit-attempt',?,'guest','cap','fp','ready','{}','coupon_audit','session_audit','cs_probe','2099-01-01','2026','2026')"
      )
      .bind(o.orderId)
      .run();
    await cancelOrderById(db, o.orderId);
    await adjustStock(db, 'TEE-1', -5, 'correction');
    const session = {
      id: 'cs_probe',
      payment_status: 'paid',
      amount_total: o.totalCents,
      currency: 'usd',
      metadata: { order_id: o.orderId, attempt_id: 'audit-attempt' },
      payment_intent: 'pi_probe',
      status: 'complete',
      mode: 'payment',
      collected_information: {
        shipping_details: { name: 'Fixture', address: { line1: 'Fixture', country: 'US' } },
      },
    };
    const deliver = (id: string, type: string, object: object) =>
      deliverStripeEvent(db, provider, JSON.stringify({ id, type, data: { object } }), 'fixture');
    await deliver('created', 'charge.dispute.created', {
      id: 'dp_probe',
      payment_intent: 'pi_probe',
    });
    await expect(deliver('paid', 'checkout.session.completed', session)).rejects.toThrow(
      'Payment recovery remains unresolved'
    );
    await rememberProviderSession(db, session);
    await expect(
      processInboxEvent(db, 'reconcile-session-cs_probe-paid', provider)
    ).rejects.toThrow('Payment recovery remains unresolved');
    // Older code acknowledged this synthetic event even though recovery was blocked.
    await db
      .prepare(
        "UPDATE webhook_inbox SET status='processed',processed_at='2026' WHERE event_id='reconcile-session-cs_probe-paid'"
      )
      .run();
    await deliver('won', 'charge.dispute.closed', {
      id: 'dp_probe',
      payment_intent: 'pi_probe',
      status: 'won',
    });
    expect(
      await db
        .prepare(
          "SELECT status,processed_at FROM webhook_inbox WHERE event_id='reconcile-session-cs_probe-paid'"
        )
        .first()
    ).toMatchObject({ status: 'pending', processed_at: null });
    await processInboxEvent(db, 'paid', provider);
    await processInboxEvent(db, 'reconcile-session-cs_probe-paid', provider);
    expect(
      await db
        .prepare('SELECT status,payment_status FROM orders WHERE id=?')
        .bind(o.orderId)
        .first()
    ).toMatchObject({ status: 'canceled', payment_status: 'refunded' });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM refunds').first<{ n: number }>())?.n).toBe(
      1
    );
    expect(refundCalls).toBe(1);
  } finally {
    await dispose();
  }
});

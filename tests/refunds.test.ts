import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct, expectLedgerMatchesCounters } from './helpers/d1';
import {
  createPendingOrder,
  createOrderAccessToken,
  verifyOrderAccessToken,
} from '../web/src/server/checkout';
import { handleRefundEvent, settleRefund } from '../web/src/server/refunds';
vi.mock('../web/src/server/payments', () => ({
  getStripeProvider: (env: { STRIPE_SECRET_KEY?: string }) => ({
    async refund(_pi: string, _amount: number, key: string) {
      if (env.STRIPE_SECRET_KEY === 'sk_test_invalid_key') throw new Error('ambiguous timeout');
      return { id: `re_${key}`, status: 'succeeded' };
    },
  }),
}));
import { refundOrder } from '../web/src/server/admin-actions';
import { pendingIntent } from './helpers/pending-intent';

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  await seedProduct(db, { onHand: 4, priceCents: 2000 });
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
     VALUES ('customer-1', 'Customer', 'owner@example.com', 1, 'customer', ?, ?)`
    )
    .bind(now, now)
    .run();
});
afterAll(async () => {
  await dispose();
});

describe('order ownership and success-page tokens', () => {
  it('stores user_id at checkout and signs success access per order', async () => {
    const order = await createPendingOrder(
      db,
      {
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        email: 'owner@example.com',
        userId: 'customer-1',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      },
      pendingIntent()
    );
    const row = await db
      .prepare('SELECT user_id FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ user_id: string }>();
    expect(row?.user_id).toBe('customer-1');

    const token = await createOrderAccessToken('test-secret', order.orderId);
    await expect(verifyOrderAccessToken('test-secret', order.orderId, token)).resolves.toBe(true);
    await expect(verifyOrderAccessToken('test-secret', 'another-order', token)).resolves.toBe(
      false
    );
    await expect(verifyOrderAccessToken('wrong-secret', order.orderId, token)).resolves.toBe(false);
    await expect(verifyOrderAccessToken('test-secret', order.orderId, '')).resolves.toBe(false);
  });
});

describe('failed refund attempts', () => {
  it('an ambiguous Stripe failure reserves balance until a terminal provider event', async () => {
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO orders (id, number, status, payment_status, customer_email, currency, subtotal_cents, total_cents, stripe_payment_intent_id, created_at, updated_at)
       VALUES ('refund-fail-order', 'ORD-FAIL', 'paid', 'paid', 'owner@example.com', 'USD', 2000, 2000, 'pi_fail', ?, ?)`
      )
      .bind(now, now)
      .run();
    await expect(
      refundOrder(
        db,
        {
          STRIPE_SECRET_KEY: 'sk_test_invalid_key',
          STRIPE_WEBHOOK_SECRET: 'whsec_invalid',
        } as never,
        'refund-fail-order',
        2000
      )
    ).rejects.toThrow();
    const failed = await db
      .prepare("SELECT status FROM refunds WHERE order_id = 'refund-fail-order'")
      .first<{ status: string }>();
    expect(failed?.status).toBe('uncertain');
    const pending = await db
      .prepare("SELECT id FROM refunds WHERE order_id='refund-fail-order'")
      .first<{ id: string }>();
    expect((await refundOrder(db, {} as never, 'refund-fail-order', 2000)).ok).toBe(false);
    await settleRefund(db, pending!.id, 'failed');
    // The full balance is still refundable afterwards.
    const ok = await refundOrder(db, {} as never, 'refund-fail-order', 2000);
    expect(ok.ok).toBe(true);
  }, 60_000);
});

describe('cumulative refunds with restock', () => {
  it('allows distinct partial refunds, blocks over-refunding, and restocks a full refund', async () => {
    const now = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          `INSERT INTO orders (id, number, status, payment_status, customer_email, user_id, currency, subtotal_cents, total_cents, stripe_payment_intent_id, created_at, updated_at)
         VALUES ('refund-order', 'ORD-REFUND', 'paid', 'paid', 'owner@example.com', 'customer-1', 'USD', 4000, 4000, 'pi_refund', ?, ?)`
        )
        .bind(now, now),
      db.prepare(
        `INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents)
         VALUES ('refund-item', 'refund-order', 'TEE-1', 'Tee', 2, 2000)`
      ),
    ]);
    // Record the original sale through the real hold/commit path.
    const { reserveStock, commitReservation } = await import('../web/src/server/inventory');
    const held = await reserveStock(db, [{ sku: 'TEE-1', qty: 2 }], { orderId: 'refund-order' });
    for (const reservationId of held) await commitReservation(db, reservationId);

    const env = {} as Cloudflare.Env;
    const first = await refundOrder(db, env, 'refund-order', 1000, false);
    expect(first.ok).toBe(true);
    const second = await refundOrder(db, env, 'refund-order', 1000, false);
    expect(second.ok).toBe(true);
    const tooMuch = await refundOrder(db, env, 'refund-order', 2001, false);
    expect(tooMuch.ok).toBe(false);

    const rest = await refundOrder(db, env, 'refund-order', undefined, true);
    expect(rest.ok).toBe(true);
    if (rest.ok) expect(rest.amount).toBe(2000);
    const order = await db
      .prepare('SELECT status, payment_status FROM orders WHERE id = ?')
      .bind('refund-order')
      .first<{ status: string; payment_status: string }>();
    expect(order).toEqual({ status: 'refunded', payment_status: 'refunded' });
    const refunds = await db
      .prepare('SELECT COUNT(*) AS c, SUM(amount_cents) AS s FROM refunds WHERE order_id = ?')
      .bind('refund-order')
      .first<{ c: number; s: number }>();
    expect(refunds).toEqual({ c: 3, s: 4000 });
    const counters = await expectLedgerMatchesCounters(db, 'TEE-1');
    expect(counters.on_hand).toBe(4);
  });
});

describe('Dashboard refunds', () => {
  it('records a Dashboard refund while an unsent local refund holds the balance', async () => {
    const at = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO orders(id,number,customer_email,status,payment_status,subtotal_cents,discount_cents,shipping_cents,tax_cents,total_cents,currency,stripe_payment_intent_id,created_at,updated_at)
      VALUES('o-dash','ORD-DASH','a@example.invalid','paid','paid',1000,0,0,0,1000,'USD','pi_dash',?,?)`
      )
      .bind(at, at)
      .run();
    await db
      .prepare(
        `INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,status,created_at) VALUES('local-dash','local-dash','o-dash',700,'staff','uncertain',?)`
      )
      .bind(at)
      .run();
    await handleRefundEvent(db, 'refund.updated', {
      id: 're_dash',
      amount: 1000,
      payment_intent: 'pi_dash',
      status: 'succeeded',
    });
    expect(
      await db.prepare("SELECT purpose,status FROM refunds WHERE id='re_dash'").first()
    ).toMatchObject({ purpose: 'external', status: 'succeeded' });
    await expect(
      db
        .prepare(
          `INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,status,created_at) VALUES('extra-dash','extra-dash','o-dash',1,'staff','pending',?)`
        )
        .bind(at)
        .run()
    ).rejects.toThrow(/exceeds/);
  });
});

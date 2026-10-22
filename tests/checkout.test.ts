import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliverStripeEvent } from './helpers/webhook';
import { createTestDb, seedProduct, expectLedgerMatchesCounters } from './helpers/d1';
import {
  cancelOrderById,
  createPendingOrder,
  processInboxEvent,
  reprocessStaleInbox,
} from '../web/src/server/checkout';
import { releaseExpiredReservations } from '../web/src/server/inventory';
import type { PaymentProvider } from '../web/src/server/payments';

let db: D1Database;
let dispose: () => Promise<void>;

const refundCalls: { pi: string; amount?: number; rowId: string }[] = [];
const fakeProvider: PaymentProvider = {
  async createCheckout() {
    return { sessionId: 'cs_fake', url: 'https://stripe.test/checkout' };
  },
  async verifyWebhook(payload: string) {
    const e = JSON.parse(payload) as { id: string; type: string; data: { object: unknown } };
    return { id: e.id, type: e.type, data: e.data.object };
  },
  async refund(pi: string, amount: number | undefined, rowId: string) {
    refundCalls.push({ pi, amount, rowId });
    return { id: `re_${rowId}`, status: 'succeeded' };
  },
  async findCheckoutSessionIdByPaymentIntent(pi: string) {
    return pi === 'pi_unknown' ? 'cs_fail' : null;
  },
};

function completedEvent(
  eventId: string,
  sessionId: string,
  orderId: string,
  amountTotal: number,
  pi = 'pi_1'
) {
  return JSON.stringify({
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        payment_status: 'paid',
        payment_intent: pi,
        amount_total: amountTotal,
        currency: 'usd',
        collected_information: {
          shipping_details: {
            name: 'Fixture Buyer',
            address: { line1: '1 Test St', country: 'US' },
          },
        },
        metadata: { order_id: orderId, attempt_id: 'a1' },
      },
    },
  });
}

async function attach(orderId: string, sessionId: string) {
  await db
    .prepare('UPDATE orders SET stripe_checkout_session_id = ? WHERE id = ?')
    .bind(sessionId, orderId)
    .run();
}

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  await seedProduct(db, { onHand: 10, priceCents: 2000 });
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO shipping_zones (id, name, countries_json, created_at) VALUES ('z1', 'US', '["US"]', ?)`
      )
      .bind(now),
    db.prepare(
      `INSERT INTO shipping_rates (id, zone_id, name, kind, amount_cents) VALUES ('r1', 'z1', 'Standard', 'flat', 500)`
    ),
    db
      .prepare(
        `INSERT INTO discounts (id, code, type, value, status, max_discount_cents, usage_per_customer, created_at)
       VALUES ('d1', 'SAVE10', 'percentage', 10, 'active', 300, 1, ?)`
      )
      .bind(now),
  ]);
});
afterAll(async () => {
  await dispose();
});

describe('money: discounts, shipping, paid transition', () => {
  it('percent discount is capped, excludes shipping, and the paid event commits stock exactly once', async () => {
    // 2 x $20 = $40 subtotal; 10% = 400 but capped at 300; shipping 500.
    const order = await createPendingOrder(db, {
      shippingCountry: 'US',
      email: 'buyer@example.com',
      lines: [{ sku: 'TEE-1', qty: 2 }],
      discountCode: 'SAVE10',
      shippingRateId: 'r1',
    });
    expect(order.discountCents).toBe(300);
    expect(order.shippingCents).toBe(500);
    expect(order.totalCents).toBe(4000 - 300 + 500);
    await attach(order.orderId, 'cs_1');

    const payload = completedEvent('evt_1', 'cs_1', order.orderId, order.totalCents);
    await deliverStripeEvent(db, fakeProvider, payload, 'sig');
    // Replays must not double-commit or double-email.
    await deliverStripeEvent(db, fakeProvider, payload, 'sig');
    await processInboxEvent(db, 'evt_1', fakeProvider);

    const row = await db
      .prepare('SELECT status, payment_status FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ status: string; payment_status: string }>();
    expect(row).toEqual({ status: 'paid', payment_status: 'paid' });
    const counters = await expectLedgerMatchesCounters(db, 'TEE-1');
    expect(counters).toEqual({ on_hand: 8, reserved: 0 });
    const emails = await db
      .prepare("SELECT COUNT(*) AS c FROM outbox WHERE type = 'email.send'")
      .first<{ c: number }>();
    expect(emails?.c).toBe(1);
  });

  it('once-per-customer discount cannot be reused, and cancel releases it', async () => {
    await expect(
      createPendingOrder(db, {
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        email: 'Buyer@Example.com',
        lines: [{ sku: 'TEE-1', qty: 1 }],
        discountCode: 'SAVE10',
      })
    ).rejects.toThrow();
    // A different customer can use it; canceling releases the usage.
    const other = await createPendingOrder(db, {
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      email: 'other@example.com',
      lines: [{ sku: 'TEE-1', qty: 1 }],
      discountCode: 'SAVE10',
    });
    await cancelOrderById(db, other.orderId);
    const again = await createPendingOrder(db, {
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      email: 'other@example.com',
      lines: [{ sku: 'TEE-1', qty: 1 }],
      discountCode: 'SAVE10',
    });
    expect(again.discountCents).toBe(200);
    await cancelOrderById(db, again.orderId);
    await expectLedgerMatchesCounters(db, 'TEE-1');
  });
});

describe('delayed payments and dashboard refunds', () => {
  it('an order awaiting a delayed payment is not auto-canceled, and a dashboard refund creates a local row', async () => {
    const { cancelExpiredPendingOrders } = await import('../web/src/server/checkout');
    const old = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    await db
      .prepare(
        `INSERT INTO orders (id, number, customer_email, currency, subtotal_cents, total_cents, status, payment_status, stripe_payment_intent_id, checkout_attempt_id, created_at, updated_at)
         VALUES ('delayed-1', 'D-1', 'delayed@example.com', 'USD', 2000, 2000, 'pending_payment', 'unpaid', 'pi_delayed', 'att-delayed', ?, ?)`
      )
      .bind(old, old)
      .run();
    await cancelExpiredPendingOrders(db);
    const still = await db
      .prepare("SELECT status FROM orders WHERE id = 'delayed-1'")
      .first<{ status: string }>();
    expect(still?.status).toBe('pending_payment');

    await db
      .prepare("UPDATE orders SET status = 'paid', payment_status = 'paid' WHERE id = 'delayed-1'")
      .run();
    const evt = JSON.stringify({
      id: 'evt_dash_refund',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_1',
          payment_intent: 'pi_delayed',
          amount_refunded: 2000,
          refunds: {
            data: [
              {
                id: 're_dashboard',
                payment_intent: 'pi_delayed',
                amount: 2000,
                status: 'succeeded',
              },
            ],
          },
        },
      },
    });
    await deliverStripeEvent(db, fakeProvider, evt, 'sig');
    const row = await db
      .prepare("SELECT status, payment_status FROM orders WHERE id = 'delayed-1'")
      .first<{ status: string; payment_status: string }>();
    expect(row?.payment_status).toBe('refunded');
    const refunds = await db
      .prepare("SELECT amount_cents, status FROM refunds WHERE order_id = 'delayed-1'")
      .all<{ amount_cents: number; status: string }>();
    expect(refunds.results).toEqual([{ amount_cents: 2000, status: 'succeeded' }]);
  });
});

describe('discount usage on failed checkouts', () => {
  it('an out-of-stock checkout releases the discount usage it claimed', async () => {
    const before = await db
      .prepare("SELECT usage_count FROM discounts WHERE id = 'd1'")
      .first<{ usage_count: number }>();
    await expect(
      createPendingOrder(db, {
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        email: 'oos@example.com',
        lines: [{ sku: 'TEE-1', qty: 99 }],
        discountCode: 'SAVE10',
      })
    ).rejects.toThrow();
    const after = await db
      .prepare("SELECT usage_count FROM discounts WHERE id = 'd1'")
      .first<{ usage_count: number }>();
    expect(after?.usage_count).toBe(before?.usage_count);
    const usage = await db
      .prepare("SELECT COUNT(*) AS c FROM discount_usage WHERE customer_email = 'oos@example.com'")
      .first<{ c: number }>();
    expect(usage?.c).toBe(0);
    const counters = await expectLedgerMatchesCounters(db, 'TEE-1');
    expect(counters.reserved).toBe(0);
  });
});

describe('discount claim atomicity (B10)', () => {
  it('a usage-limited code claimed inside the order batch cannot leak or double-claim', async () => {
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO discounts (id, code, type, value, status, usage_count, usage_limit, created_at)
       VALUES ('d-lim', 'ONCE', 'percentage', 10, 'active', 0, 1, ?)`
      )
      .bind(now)
      .run();
    const first = await createPendingOrder(db, {
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      email: 'once@example.com',
      lines: [{ sku: 'TEE-1', qty: 1 }],
      discountCode: 'ONCE',
    });
    expect(first.discountCents).toBeGreaterThan(0);
    // Second checkout: the claim inside its batch must fail, the batch must
    // roll back entirely, and usage must stay exactly 1 (no leaked claim).
    await expect(
      createPendingOrder(db, {
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        email: 'twice@example.com',
        lines: [{ sku: 'TEE-1', qty: 1 }],
        discountCode: 'ONCE',
      })
    ).rejects.toThrow(/Discount code is not valid/);
    const d = await db
      .prepare('SELECT usage_count FROM discounts WHERE id = ?')
      .bind('d-lim')
      .first<{ usage_count: number }>();
    expect(d?.usage_count).toBe(1);
    const orders = await db
      .prepare("SELECT COUNT(*) AS c FROM orders WHERE customer_email = 'twice@example.com'")
      .first<{ c: number }>();
    expect(orders?.c).toBe(0);
    const usage = await db
      .prepare("SELECT COUNT(*) AS c FROM discount_usage WHERE discount_id = 'd-lim'")
      .first<{ c: number }>();
    expect(usage?.c).toBe(1);
    // Release the first order's hold so later tests see a clean ledger.
    await cancelOrderById(db, first.orderId);
    await expectLedgerMatchesCounters(db, 'TEE-1');
  });
});

describe('late and out-of-order payments', () => {
  it('a payment arriving after cancellation re-reserves and pays when stock exists', async () => {
    const order = await createPendingOrder(db, {
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      email: 'late@example.com',
      lines: [{ sku: 'TEE-1', qty: 1 }],
    });
    await attach(order.orderId, 'cs_late');
    await cancelOrderById(db, order.orderId);
    await deliverStripeEvent(
      db,
      fakeProvider,
      completedEvent('evt_late', 'cs_late', order.orderId, order.totalCents, 'pi_late'),
      'sig'
    );
    const row = await db
      .prepare('SELECT status FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ status: string }>();
    expect(row?.status).toBe('paid');
    const counters = await expectLedgerMatchesCounters(db, 'TEE-1');
    expect(counters.reserved).toBe(0);
  });

  it('a payment arriving when stock is gone refunds automatically and alerts', async () => {
    refundCalls.length = 0;
    const order = await createPendingOrder(db, {
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      email: 'gone@example.com',
      lines: [{ sku: 'TEE-1', qty: 1 }],
    });
    await attach(order.orderId, 'cs_gone');
    await cancelOrderById(db, order.orderId);
    // Someone else buys the remaining stock.
    const stock = await db
      .prepare('SELECT on_hand FROM stock WHERE sku = ?')
      .bind('TEE-1')
      .first<{ on_hand: number }>();
    const { adjustStock } = await import('../web/src/server/inventory');
    await adjustStock(db, 'TEE-1', -(stock?.on_hand ?? 0), 'correction');
    await deliverStripeEvent(
      db,
      fakeProvider,
      completedEvent('evt_gone', 'cs_gone', order.orderId, order.totalCents, 'pi_gone'),
      'sig'
    );
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0]?.pi).toBe('pi_gone');
    const row = await db
      .prepare('SELECT payment_status FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ payment_status: string }>();
    expect(row?.payment_status).toBe('refunded');
    await expectLedgerMatchesCounters(db, 'TEE-1');
    // Restore stock for the following tests.
    await adjustStock(db, 'TEE-1', 7, 'restock');
  });

  it('a Stripe error on the late-payment refund preserves the uncertain row, sends no refund email, and a replay reuses the same row', async () => {
    const order = await createPendingOrder(db, {
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      email: 'flaky@example.com',
      lines: [{ sku: 'TEE-1', qty: 1 }],
    });
    await attach(order.orderId, 'cs_flaky');
    await cancelOrderById(db, order.orderId);
    const stock = await db
      .prepare('SELECT on_hand FROM stock WHERE sku = ?')
      .bind('TEE-1')
      .first<{ on_hand: number }>();
    const { adjustStock } = await import('../web/src/server/inventory');
    await adjustStock(db, 'TEE-1', -(stock?.on_hand ?? 0), 'correction');

    let attempts = 0;
    const flaky: PaymentProvider = {
      ...fakeProvider,
      async refund() {
        attempts++;
        if (attempts === 1) throw new Error('stripe down');
        return { id: 're_flaky', status: 'succeeded' };
      },
    };
    const outboxBefore = await db
      .prepare("SELECT COUNT(*) AS c FROM outbox WHERE type='email.send'")
      .first<{ c: number }>();
    await expect(
      deliverStripeEvent(
        db,
        flaky,
        completedEvent('evt_flaky1', 'cs_flaky', order.orderId, order.totalCents, 'pi_flaky'),
        'sig'
      )
    ).rejects.toThrow();
    const failedRows = await db
      .prepare('SELECT id, status FROM refunds WHERE order_id = ?')
      .bind(order.orderId)
      .all<{ id: string; status: string }>();
    expect(failedRows.results).toEqual([{ id: `late-${order.orderId}`, status: 'uncertain' }]);
    const notRefunded = await db
      .prepare('SELECT payment_status FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ payment_status: string }>();
    expect(notRefunded?.payment_status).not.toBe('refunded');
    const outboxMid = await db
      .prepare("SELECT COUNT(*) AS c FROM outbox WHERE type='email.send'")
      .first<{ c: number }>();
    expect(outboxMid?.c ?? 0).toBe(outboxBefore?.c ?? 0);

    await db.prepare("UPDATE webhook_inbox SET retry_after=NULL WHERE event_id='evt_flaky1'").run();
    await db
      .prepare('UPDATE refunds SET retry_after=NULL WHERE order_id=?')
      .bind(order.orderId)
      .run();
    // Replay the SAME event (Stripe retries keep the event id): the inbox
    // row resets from failed and the deterministic refund row is reused.
    await deliverStripeEvent(
      db,
      flaky,
      completedEvent('evt_flaky1', 'cs_flaky', order.orderId, order.totalCents, 'pi_flaky'),
      'sig'
    );
    const rows = await db
      .prepare('SELECT id, status FROM refunds WHERE order_id = ?')
      .bind(order.orderId)
      .all<{ id: string; status: string }>();
    expect(rows.results).toEqual([{ id: `late-${order.orderId}`, status: 'succeeded' }]);
    const refunded = await db
      .prepare('SELECT payment_status FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ payment_status: string }>();
    expect(refunded?.payment_status).toBe('refunded');
    await adjustStock(db, 'TEE-1', 7, 'restock');
  });

  it('a pending Stripe refund on a late payment does not mark the order refunded or email the customer', async () => {
    const order = await createPendingOrder(db, {
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      email: 'pendref@example.com',
      lines: [{ sku: 'TEE-1', qty: 1 }],
    });
    await attach(order.orderId, 'cs_pendref');
    await cancelOrderById(db, order.orderId);
    const stock = await db
      .prepare('SELECT on_hand FROM stock WHERE sku = ?')
      .bind('TEE-1')
      .first<{ on_hand: number }>();
    const { adjustStock } = await import('../web/src/server/inventory');
    await adjustStock(db, 'TEE-1', -(stock?.on_hand ?? 0), 'correction');
    const pendingProvider: PaymentProvider = {
      ...fakeProvider,
      async refund() {
        return { id: 're_pending', status: 'pending' };
      },
    };
    const outboxBefore = await db
      .prepare(
        "SELECT COUNT(*) AS c FROM outbox WHERE type='email.send' AND payload_json LIKE '%pendref@example.com%'"
      )
      .first<{ c: number }>();
    await deliverStripeEvent(
      db,
      pendingProvider,
      completedEvent('evt_pendref', 'cs_pendref', order.orderId, order.totalCents, 'pi_pendref'),
      'sig'
    );
    const row = await db
      .prepare('SELECT payment_status FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ payment_status: string }>();
    expect(row?.payment_status).not.toBe('refunded');
    const outboxAfter = await db
      .prepare(
        "SELECT COUNT(*) AS c FROM outbox WHERE type='email.send' AND payload_json LIKE '%pendref@example.com%'"
      )
      .first<{ c: number }>();
    expect(outboxAfter?.c ?? 0).toBe(outboxBefore?.c ?? 0);
    await adjustStock(db, 'TEE-1', 7, 'restock');
  });

  it('expired holds release, and dispute closed (won) restores paid', async () => {
    const order = await createPendingOrder(db, {
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      email: 'disp@example.com',
      lines: [{ sku: 'TEE-1', qty: 1 }],
    });
    await attach(order.orderId, 'cs_disp');
    await deliverStripeEvent(
      db,
      fakeProvider,
      completedEvent('evt_disp', 'cs_disp', order.orderId, order.totalCents, 'pi_disp'),
      'sig'
    );
    const dispute = JSON.stringify({
      id: 'evt_dp1',
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', payment_intent: 'pi_disp' } },
    });
    await deliverStripeEvent(db, fakeProvider, dispute, 'sig');
    let row = await db
      .prepare('SELECT payment_status FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ payment_status: string }>();
    expect(row?.payment_status).toBe('disputed');
    const closed = JSON.stringify({
      id: 'evt_dp2',
      type: 'charge.dispute.closed',
      data: { object: { id: 'dp_1', payment_intent: 'pi_disp', status: 'won' } },
    });
    await deliverStripeEvent(db, fakeProvider, closed, 'sig');
    row = await db
      .prepare('SELECT payment_status FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ payment_status: string }>();
    expect(row?.payment_status).toBe('paid');

    // Hold expiry path.
    const held = await createPendingOrder(db, {
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      email: 'hold@example.com',
      lines: [{ sku: 'TEE-1', qty: 1 }],
    });
    await db
      .prepare("UPDATE reservations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE order_id = ?")
      .bind(held.orderId)
      .run();
    const released = await releaseExpiredReservations(db);
    expect(released).toBeGreaterThan(0);
    await expectLedgerMatchesCounters(db, 'TEE-1');
  });

  it('payment_intent.payment_failed resolves the session through Stripe and retains its hold for retry', async () => {
    const order = await createPendingOrder(db, {
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      email: 'fail@example.com',
      lines: [{ sku: 'TEE-1', qty: 1 }],
    });
    await attach(order.orderId, 'cs_fail');
    const failed = JSON.stringify({
      id: 'evt_pi_fail',
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_unknown' } },
    });
    await deliverStripeEvent(db, fakeProvider, failed, 'sig');
    const row = await db
      .prepare('SELECT status FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ status: string }>();
    expect(row?.status).toBe('pending_payment');
    await expectLedgerMatchesCounters(db, 'TEE-1');
  });

  it('a failed inbox row is recovered by the sweep with exactly one transition', async () => {
    const order = await createPendingOrder(db, {
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      email: 'retry@example.com',
      lines: [{ sku: 'TEE-1', qty: 1 }],
    });
    await attach(order.orderId, 'cs_retry');
    await db
      .prepare(
        `INSERT INTO webhook_inbox (id, provider, event_id, type, payload_json, status, received_at, attempts)
                VALUES ('w2', 'stripe', 'evt_retry', 'checkout.session.completed', ?, 'failed', ?, 2)`
      )
      .bind(
        completedEvent('evt_retry', 'cs_retry', order.orderId, order.totalCents, 'pi_retry'),
        new Date().toISOString()
      )
      .run();
    const before = await db
      .prepare("SELECT COUNT(*) AS c FROM outbox WHERE type = 'email.send'")
      .first<{ c: number }>();
    await reprocessStaleInbox(db, fakeProvider);
    await reprocessStaleInbox(db, fakeProvider);
    const row = await db
      .prepare('SELECT status FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ status: string }>();
    expect(row?.status).toBe('paid');
    const after = await db
      .prepare("SELECT COUNT(*) AS c FROM outbox WHERE type = 'email.send'")
      .first<{ c: number }>();
    expect((after?.c ?? 0) - (before?.c ?? 0)).toBe(1);
    await expectLedgerMatchesCounters(db, 'TEE-1');
  });

  it('stale inbox rows are reprocessed by the sweep', async () => {
    const order = await createPendingOrder(db, {
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      email: 'sweep@example.com',
      lines: [{ sku: 'TEE-1', qty: 1 }],
    });
    await attach(order.orderId, 'cs_sweep');
    await db
      .prepare(
        `INSERT INTO webhook_inbox (id, provider, event_id, type, payload_json, status, received_at, attempts)
                VALUES ('w1', 'stripe', 'evt_sweep', 'checkout.session.completed', ?, 'pending', '2000-01-01T00:00:00.000Z', 0)`
      )
      .bind(completedEvent('evt_sweep', 'cs_sweep', order.orderId, order.totalCents, 'pi_sweep'))
      .run();
    const done = await reprocessStaleInbox(db, fakeProvider);
    expect(done).toBe(1);
    const row = await db
      .prepare('SELECT status FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ status: string }>();
    expect(row?.status).toBe('paid');
  });
});

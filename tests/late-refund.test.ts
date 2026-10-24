import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliverStripeEvent } from './helpers/webhook';
import { createTestDb, seedProduct } from './helpers/d1';
import { cancelOrderById, createPendingOrder, processInboxEvent } from '../web/src/server/checkout';
import { adjustStock } from '../web/src/server/inventory';
import type { PaymentProvider } from '../web/src/server/payments';
import { pendingIntent } from './helpers/pending-intent';

// P0 item 2: a payment that arrives after holds expired (stock gone) is
// refunded deterministically, and the refund settles only when Stripe
// says the money moved (refund.updated / charge.refunded) — never on the
// optimistic pending response, and never twice on replay.
let db: D1Database;
let dispose: () => Promise<void>;
const refundCalls: string[] = [];

const pendingRefundProvider: PaymentProvider = {
  async createCheckout() {
    return { sessionId: 'cs_x', url: 'https://stripe.test/x' };
  },
  async verifyWebhook(payload: string) {
    const e = JSON.parse(payload) as { id: string; type: string; data: { object: unknown } };
    return { id: e.id, type: e.type, data: e.data.object };
  },
  async refund(pi: string, _amount: number | undefined, rowId: string) {
    refundCalls.push(rowId);
    return { id: `re_${rowId}`, status: 'pending' };
  },
};

function completed(
  eventId: string,
  sessionId: string,
  orderId: string,
  amount: number,
  pi: string
) {
  return JSON.stringify({
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        payment_status: 'paid',
        payment_intent: pi,
        amount_total: amount,
        currency: 'usd',
        collected_information: {
          shipping_details: {
            name: 'Fixture Buyer',
            address: { line1: '1 Test St', country: 'US' },
          },
        },
        metadata: { order_id: orderId },
      },
    },
  });
}

async function refundedEmails(): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS c FROM outbox WHERE payload_json LIKE '%refunded in full%'")
    .first<{ c: number }>();
  return row?.c ?? 0;
}

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  await seedProduct(db, { onHand: 1, priceCents: 2000 });
  await db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('operational_alert_email', 'owner@store.test', '2026-01-01T00:00:00.000Z')"
    )
    .run();
});
afterAll(async () => {
  await dispose();
});

describe('late payment refund settlement', () => {
  it('pending refund settles on refund.updated, exactly one customer email, replay-safe', async () => {
    const order = await createPendingOrder(
      db,
      {
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        email: 'late@example.com',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      },
      pendingIntent()
    );
    await db
      .prepare('UPDATE orders SET stripe_checkout_session_id = ? WHERE id = ?')
      .bind('cs_late', order.orderId)
      .run();
    await cancelOrderById(db, order.orderId); // hold released, order canceled
    await adjustStock(db, 'TEE-1', -1, 'damaged'); // stock is gone now

    await deliverStripeEvent(
      db,
      pendingRefundProvider,
      completed('evt_late1', 'cs_late', order.orderId, order.totalCents, 'pi_late'),
      'sig'
    );
    expect(refundCalls).toEqual([`late-${order.orderId}`]);
    const afterPending = await db
      .prepare('SELECT status, payment_status, stripe_payment_intent_id FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ status: string; payment_status: string; stripe_payment_intent_id: string }>();
    // PI persisted even though the refund is only pending; order not yet refunded.
    expect(afterPending?.stripe_payment_intent_id).toBe('pi_late');
    expect(afterPending?.payment_status).not.toBe('refunded');
    expect(await refundedEmails()).toBe(0);
    const row = await db
      .prepare('SELECT status, stripe_refund_id FROM refunds WHERE id = ?')
      .bind(`late-${order.orderId}`)
      .first<{ status: string; stripe_refund_id: string }>();
    expect(row).toEqual({ status: 'pending', stripe_refund_id: `re_late-${order.orderId}` });

    const settled = JSON.stringify({
      id: 'evt_ru1',
      type: 'refund.updated',
      data: {
        object: {
          id: `re_late-${order.orderId}`,
          payment_intent: 'pi_late',
          status: 'succeeded',
          amount: order.totalCents,
        },
      },
    });
    await deliverStripeEvent(db, pendingRefundProvider, settled, 'sig');
    const afterSettle = await db
      .prepare('SELECT status, payment_status FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ status: string; payment_status: string }>();
    // Deliberate policy: a late payment on a canceled order refunds in
    // full without resurrecting its fulfillment status — settlement
    // alone can never make a canceled order shippable again.
    expect(afterSettle).toEqual({ status: 'canceled', payment_status: 'refunded' });
    expect(await refundedEmails()).toBe(1);

    // Replays (same inbox event, and the original paid event under a new
    // delivery) must not re-refund or re-email.
    await processInboxEvent(db, 'evt_ru1', pendingRefundProvider);
    await deliverStripeEvent(
      db,
      pendingRefundProvider,
      completed('evt_late1b', 'cs_late', order.orderId, order.totalCents, 'pi_late'),
      'sig'
    );
    expect(refundCalls).toHaveLength(1);
    expect(await refundedEmails()).toBe(1);
  }, 60_000);

  it('canceled order paid by card settles through charge.refunded', async () => {
    await adjustStock(db, 'TEE-1', 1, 'restock');
    const order = await createPendingOrder(
      db,
      {
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        email: 'late2@example.com',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      },
      pendingIntent()
    );
    await db
      .prepare('UPDATE orders SET stripe_checkout_session_id = ? WHERE id = ?')
      .bind('cs_late2', order.orderId)
      .run();
    await cancelOrderById(db, order.orderId);
    await adjustStock(db, 'TEE-1', -1, 'damaged');

    await deliverStripeEvent(
      db,
      pendingRefundProvider,
      completed('evt_late2', 'cs_late2', order.orderId, order.totalCents, 'pi_late2'),
      'sig'
    );
    const charged = JSON.stringify({
      id: 'evt_cr2',
      type: 'charge.refunded',
      data: {
        object: { id: 'ch_2', payment_intent: 'pi_late2', amount_refunded: order.totalCents },
      },
    });
    await deliverStripeEvent(db, pendingRefundProvider, charged, 'sig');
    const row = await db
      .prepare('SELECT status, payment_status FROM orders WHERE id = ?')
      .bind(order.orderId)
      .first<{ status: string; payment_status: string }>();
    // Same policy via charge.refunded: payment status records the
    // refund; the canceled fulfillment status is preserved.
    expect(row).toEqual({ status: 'canceled', payment_status: 'refunded' });
    const refundRow = await db
      .prepare('SELECT status FROM refunds WHERE id = ?')
      .bind(`late-${order.orderId}`)
      .first<{ status: string }>();
    expect(refundRow?.status).toBe('succeeded');
    const refundRows = await db
      .prepare('SELECT COUNT(*) AS c FROM refunds WHERE order_id = ?')
      .bind(order.orderId)
      .first<{ c: number }>();
    expect(refundRows?.c).toBe(1); // no duplicate delta row recorded
  }, 60_000);

  it('inbox retry cap alerts the owner with the event id', async () => {
    await adjustStock(db, 'TEE-1', 1, 'restock');
    const order = await createPendingOrder(
      db,
      {
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        email: 'cap@example.com',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      },
      pendingIntent()
    ).catch(() => null);
    expect(order).not.toBeNull();
    await db
      .prepare('UPDATE orders SET stripe_checkout_session_id = ? WHERE id = ?')
      .bind('cs_cap', order!.orderId)
      .run();
    const payload = completed('evt_cap', 'cs_cap', order!.orderId, 1, 'pi_cap'); // amount below total -> handler throws
    await db
      .prepare(
        `INSERT INTO webhook_inbox (id, provider, event_id, type, payload_json, status, attempts, received_at)
       VALUES ('inbox-cap', 'stripe', 'evt_cap', 'checkout.session.completed', ?, 'failed', 4, ?)`
      )
      .bind(payload, new Date().toISOString())
      .run();
    await expect(processInboxEvent(db, 'evt_cap', pendingRefundProvider)).rejects.toThrow();
    const inbox = await db
      .prepare('SELECT attempts FROM webhook_inbox WHERE event_id = ?')
      .bind('evt_cap')
      .first<{ attempts: number }>();
    expect(inbox?.attempts).toBe(5);
    const alert = await db
      .prepare(
        "SELECT COUNT(*) AS c FROM outbox WHERE payload_json LIKE '%Webhook processing failed permanently%' AND payload_json LIKE '%evt_cap%'"
      )
      .first<{ c: number }>();
    expect(alert?.c).toBe(1);
    await cancelOrderById(db, order!.orderId).catch(() => undefined);
  }, 60_000);
});

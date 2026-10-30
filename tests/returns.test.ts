import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deliverStripeEvent } from './helpers/webhook';
import { createTestDb, seedProduct, expectLedgerMatchesCounters } from './helpers/d1';
import { attachStripeSession } from './helpers/attach-session';
import { heldOrder } from './helpers/pending-intent';
import { settleRefund } from '../web/src/server/refunds';
import { runAdminAction } from '../web/src/server/admin-actions';
import * as payments from '../web/src/server/payments';

let db: D1Database, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };
const provider = {
  async createCheckout() {
    return { sessionId: 'cs_test', url: 'https://stripe.test' };
  },
  async verifyWebhook(payload: string) {
    const e = JSON.parse(payload);
    return { ...e, data: e.data.object };
  },
  async refund(_pi: string, _amount: number, key: string) {
    return { id: `re_${key}`, status: 'pending' };
  },
};

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 10 });
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO variants (id, product_id, sku, title, price_cents, status, continue_selling, created_at) VALUES ('v2', 'p1', 'MUG-1', 'Mug', 1500, 'active', 0, ?)"
      )
      .bind(now),
    db
      .prepare("INSERT INTO stock (sku, on_hand, reserved, updated_at) VALUES ('MUG-1', 10, 0, ?)")
      .bind(now),
    db
      .prepare(
        "INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, created_at) VALUES ('seed-mug', 'MUG-1', 10, 0, 'restock', ?)"
      )
      .bind(now),
  ]);
  vi.spyOn(payments, 'getStripeProvider').mockReturnValue(provider);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await dispose();
});

async function paidOrder(name: string, lines: { sku: string; qty: number }[]) {
  const o = await heldOrder(db, {
    email: `${name}@test.com`,
    shippingCountry: 'US',
    shippingRateId: 'test-rate',
    lines,
  });
  await attachStripeSession(db, o.orderId, `cs_${name}`);
  const event = JSON.stringify({
    id: `evt_${name}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${name}`,
        payment_status: 'paid',
        payment_intent: `pi_${name}`,
        amount_total: o.totalCents,
        currency: 'usd',
        collected_information: {
          shipping_details: { name: 'Buyer', address: { line1: '1 Test St', country: 'US' } },
        },
        metadata: { order_id: o.orderId },
      },
    },
  });
  await deliverStripeEvent(db, provider, event, 'test');
  return o;
}

async function approvedReturn(orderId: string, items: { sku: string; qty: number }[]) {
  const returnId = `ret-${orderId}`;
  await db
    .prepare(
      "INSERT INTO returns (id, order_id, reason, status, created_at) VALUES (?, ?, 'test', 'approved', ?)"
    )
    .bind(returnId, orderId, new Date().toISOString())
    .run();
  for (const item of items)
    await db
      .prepare(
        "INSERT INTO return_items (id, return_id, order_item_id, sku, title, qty, unit_price_cents) SELECT ?, ?, id, sku, 'Item', ?, unit_price_cents FROM order_items WHERE order_id = ? AND sku = ?"
      )
      .bind(`${returnId}-${item.sku}`, returnId, item.qty, orderId, item.sku)
      .run();
  return returnId;
}

async function refundReturn(returnId: string, amountCents: number, restock: boolean) {
  const result = await runAdminAction(db, {}, owner, 'return.refund', {
    returnId,
    amountCents,
    restock,
  });
  expect(result.ok).toBe(true);
  const refund = await db
    .prepare("SELECT id FROM refunds WHERE return_id = ? AND status = 'pending'")
    .bind(returnId)
    .first<{ id: string }>();
  await settleRefund(db, refund?.id ?? '', 'succeeded');
  await settleRefund(db, refund?.id ?? '', 'succeeded');
}

const onHand = async (sku: string) =>
  (
    await db
      .prepare('SELECT on_hand FROM stock WHERE sku = ?')
      .bind(sku)
      .first<{ on_hand: number }>()
  )?.on_hand;

it('approved full return refund with restock returns units to stock', async () => {
  const o = await paidOrder('full', [{ sku: 'TEE-1', qty: 1 }]);
  expect(await onHand('TEE-1')).toBe(9);
  await refundReturn(
    await approvedReturn(o.orderId, [{ sku: 'TEE-1', qty: 1 }]),
    o.totalCents,
    true
  );
  expect(await onHand('TEE-1')).toBe(10);
  await expectLedgerMatchesCounters(db, 'TEE-1');
});

it('a partial return restocks only the returned SKU and quantity, once', async () => {
  const o = await paidOrder('partial', [
    { sku: 'TEE-1', qty: 2 },
    { sku: 'MUG-1', qty: 1 },
  ]);
  await refundReturn(await approvedReturn(o.orderId, [{ sku: 'TEE-1', qty: 1 }]), 2000, true);
  expect(await onHand('TEE-1')).toBe(9);
  expect(await onHand('MUG-1')).toBe(9);
  await expectLedgerMatchesCounters(db, 'TEE-1');
  await expectLedgerMatchesCounters(db, 'MUG-1');
});

it('a return refunded without restock leaves stock alone', async () => {
  const o = await paidOrder('norestock', [{ sku: 'TEE-1', qty: 1 }]);
  await refundReturn(
    await approvedReturn(o.orderId, [{ sku: 'TEE-1', qty: 1 }]),
    o.totalCents,
    false
  );
  expect(await onHand('TEE-1')).toBe(9);
});

it('a later full refund does not restock units that were never returned', async () => {
  const o = await paidOrder('later', [{ sku: 'TEE-1', qty: 2 }]);
  await refundReturn(await approvedReturn(o.orderId, [{ sku: 'TEE-1', qty: 1 }]), 2000, true);
  const rest = await runAdminAction(db, {}, owner, 'order.refund', {
    requestId: 'later-rest',
    orderId: o.orderId,
  });
  expect(rest.ok).toBe(true);
  const refund = await db
    .prepare("SELECT id FROM refunds WHERE request_id = 'later-rest'")
    .first<{ id: string }>();
  await settleRefund(db, refund?.id ?? '', 'succeeded');
  expect(await onHand('TEE-1')).toBe(9);
  await expectLedgerMatchesCounters(db, 'TEE-1');
});

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { deliverStripeEvent } from './helpers/webhook';
import { createTestDb, seedProduct, expectLedgerMatchesCounters } from './helpers/d1';
import {
  attachStripeSession,
  cancelOrderById,
  createPendingOrder,
  processInboxEvent,
  calculateShipping,
} from '../web/src/server/checkout';
import { requestRefund, settleRefund } from '../web/src/server/refunds';
import { runAdminAction } from '../web/src/server/admin-actions';
import * as payments from '../web/src/server/payments';
import { normalizeNetwork } from '../web/src/server/network';
import { publicCacheRequest, privateResponse } from '../web/src/server/public-cache';
import {
  missingStripeSubscriptions,
  REQUIRED_STRIPE_EVENTS,
} from '../web/src/server/stripe-events';
import { handledStripeSchemas } from '../web/src/schemas/webhook';

let db: D1Database, dispose: () => Promise<void>;
const provider: payments.PaymentProvider = {
  async createCheckout() {
    return { sessionId: 'cs_test', url: 'https://stripe.test' };
  },
  async verifyWebhook(payload) {
    const e = JSON.parse(payload);
    return { ...e, data: e.data.object };
  },
  async refund(_pi, _amount, key) {
    return { id: `re_${key}`, status: 'pending' };
  },
};
beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  await seedProduct(db, { onHand: 100 });
});
afterAll(async () => {
  await dispose();
});
async function order(name: string) {
  const o = await createPendingOrder(db, {
    email: `${name}@test.com`,
    shippingCountry: 'US',
    shippingRateId: 'test-rate',
    lines: [{ sku: 'TEE-1', qty: 1 }],
  });
  await attachStripeSession(db, o.orderId, `cs_${name}`);
  return o;
}
function event(o: Awaited<ReturnType<typeof order>>, name: string, id = `evt_${name}`) {
  return JSON.stringify({
    id,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${name}`,
        payment_status: 'paid',
        payment_intent: `pi_${name}`,
        amount_total: o.totalCents,
        currency: 'usd',
        collected_information: {
          shipping_details: {
            name: 'Fixture Buyer',
            address: { line1: '1 Test St', country: 'US' },
          },
        },
        metadata: { order_id: o.orderId },
      },
    },
  });
}
async function paid(name: string) {
  const o = await order(name);
  await deliverStripeEvent(db, provider, event(o, name), 'test');
  return o;
}
function pausedBatch(onReady: () => void, release: Promise<void>): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          onReady();
          await release;
          return target.batch(statements);
        };
      const v = Reflect.get(target, key);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

it('a cancellation that loses to payment cannot release committed stock', async () => {
  const o = await order('cancel-loses');
  let ready!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => {
    ready = r;
  });
  const allowed = new Promise<void>((r) => {
    release = r;
  });
  const cancel = cancelOrderById(pausedBatch(ready, allowed), o.orderId);
  await waiting;
  await deliverStripeEvent(db, provider, event(o, 'cancel-loses'), 'test');
  release();
  await cancel;
  expect(
    await db.prepare('SELECT status,payment_status FROM orders WHERE id=?').bind(o.orderId).first()
  ).toEqual({ status: 'paid', payment_status: 'paid' });
  expect(
    (
      await db
        .prepare('SELECT status FROM reservations WHERE order_id=?')
        .bind(o.orderId)
        .first<{ status: string }>()
    )?.status
  ).toBe('committed');
  await expectLedgerMatchesCounters(db, 'TEE-1');
});
it('a paid transition that follows cancellation recovers stock atomically', async () => {
  const o = await order('payment-late');
  let ready!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => {
    ready = r;
  });
  const allowed = new Promise<void>((r) => {
    release = r;
  });
  const pay = deliverStripeEvent(
    pausedBatch(ready, allowed),
    provider,
    event(o, 'payment-late'),
    'test'
  );
  await waiting;
  await cancelOrderById(db, o.orderId);
  release();
  await pay;
  expect(
    (
      await db
        .prepare('SELECT status FROM orders WHERE id=?')
        .bind(o.orderId)
        .first<{ status: string }>()
    )?.status
  ).toBe('paid');
  await expectLedgerMatchesCounters(db, 'TEE-1');
});
it('receipt insertion failure rolls back payment and inventory, then replay repairs it', async () => {
  const o = await order('receipt-rollback');
  await db
    .prepare(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON outbox WHEN NEW.id LIKE 'receipt-%' BEGIN SELECT RAISE(ABORT,'receipt test failure'); END;"
    )
    .run();
  try {
    await expect(
      deliverStripeEvent(db, provider, event(o, 'receipt-rollback'), 'test')
    ).rejects.toThrow();
  } finally {
    await db.prepare('DROP TRIGGER reject_receipt').run();
  }
  expect(
    (
      await db
        .prepare('SELECT status FROM orders WHERE id=?')
        .bind(o.orderId)
        .first<{ status: string }>()
    )?.status
  ).toBe('pending_payment');
  expect(
    (
      await db
        .prepare('SELECT status FROM reservations WHERE order_id=?')
        .bind(o.orderId)
        .first<{ status: string }>()
    )?.status
  ).toBe('active');
  await db
    .prepare("UPDATE webhook_inbox SET retry_after=NULL WHERE event_id='evt_receipt-rollback'")
    .run();
  await deliverStripeEvent(db, provider, event(o, 'receipt-rollback'), 'test');
  expect(
    (
      await db
        .prepare('SELECT COUNT(*) AS n FROM outbox WHERE id=?')
        .bind(`receipt-${o.orderId}`)
        .first<{ n: number }>()
    )?.n
  ).toBe(1);
  await expectLedgerMatchesCounters(db, 'TEE-1');
});
it('pending partial staff refunds never change the paid order until settlement', async () => {
  const o = await paid('partial');
  const input = {
    orderId: o.orderId,
    amountCents: 100,
    requestId: 'partial-operation',
    purpose: 'staff' as const,
  };
  await requestRefund(db, provider, input);
  await requestRefund(db, provider, input);
  expect(
    (
      await db
        .prepare('SELECT payment_status FROM orders WHERE id=?')
        .bind(o.orderId)
        .first<{ payment_status: string }>()
    )?.payment_status
  ).toBe('paid');
  await settleRefund(db, input.requestId, 'succeeded', 're_partial-operation');
  await settleRefund(db, input.requestId, 'pending'); // stale pending must not undo success
  const row = await db
    .prepare('SELECT payment_status,status FROM orders WHERE id=?')
    .bind(o.orderId)
    .first();
  expect(row).toEqual({ payment_status: 'partially_refunded', status: 'partially_refunded' });
  const mail = await db
    .prepare('SELECT payload_json FROM outbox WHERE id=?')
    .bind(`refund-${input.requestId}`)
    .first<{ payload_json: string }>();
  expect(mail?.payload_json).not.toContain('sold out');
});
it('concurrent pending refunds atomically reserve the refundable balance', async () => {
  const o = await paid('concurrent-refunds');
  const attempts = await Promise.allSettled(
    ['concurrent-a', 'concurrent-b'].map((requestId) =>
      requestRefund(db, provider, {
        orderId: o.orderId,
        amountCents: o.totalCents,
        requestId,
        purpose: 'staff',
      })
    )
  );
  expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(
    (
      await db
        .prepare(
          "SELECT SUM(amount_cents) AS s FROM refunds WHERE order_id=? AND status NOT IN ('failed','canceled')"
        )
        .bind(o.orderId)
        .first<{ s: number }>()
    )?.s
  ).toBe(o.totalCents);
});
it('failed and canceled refunds release balance, and out-of-order pending cannot revive them', async () => {
  const o = await paid('failed-refund');
  for (const status of ['failed', 'canceled']) {
    const requestId = `terminal-${status}`;
    await requestRefund(db, provider, {
      orderId: o.orderId,
      amountCents: o.totalCents,
      requestId,
      purpose: 'staff',
    });
    await settleRefund(db, requestId, status);
    await settleRefund(db, requestId, 'pending');
    expect(
      (
        await db
          .prepare('SELECT status FROM refunds WHERE id=?')
          .bind(requestId)
          .first<{ status: string }>()
      )?.status
    ).toBe(status);
  }
  expect(
    (
      await db
        .prepare('SELECT payment_status FROM orders WHERE id=?')
        .bind(o.orderId)
        .first<{ payment_status: string }>()
    )?.payment_status
  ).toBe('paid');
});
it('return refund permission cannot be bypassed; pending returns remain retryable', async () => {
  const o = await paid('return');
  await db
    .prepare(
      "INSERT INTO returns(id,order_id,reason,created_at) VALUES('safety-return',?,'test',?)"
    )
    .bind(o.orderId, new Date().toISOString())
    .run();
  const denied = await runAdminAction(
    db,
    {} as never,
    { id: 'support', role: 'support' },
    'return.refund',
    { returnId: 'safety-return', amountCents: 100 }
  );
  expect(denied).toMatchObject({ ok: false, status: 403 });
  const spy = vi.spyOn(payments, 'getStripeProvider').mockReturnValue(provider as never);
  try {
    expect(
      (
        await runAdminAction(db, {} as never, { id: 'owner', role: 'owner' }, 'return.approve', {
          returnId: 'safety-return',
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await db
          .prepare("SELECT status FROM returns WHERE id='safety-return'")
          .first<{ status: string }>()
      )?.status
    ).toBe('approved');
    expect(
      (
        await runAdminAction(db, {} as never, { id: 'owner', role: 'owner' }, 'return.refund', {
          returnId: 'safety-return',
          amountCents: 100,
        })
      ).ok
    ).toBe(true);
    const refund = await db
      .prepare("SELECT id FROM refunds WHERE return_id='safety-return'")
      .first<{ id: string }>();
    await settleRefund(db, refund!.id, 'failed');
    expect(
      (
        await runAdminAction(db, {} as never, { id: 'owner', role: 'owner' }, 'return.refund', {
          returnId: 'safety-return',
          amountCents: 100,
        })
      ).ok
    ).toBe(true);
    const retry = await db
      .prepare("SELECT id FROM refunds WHERE return_id='safety-return' AND status='pending'")
      .first<{ id: string }>();
    expect(retry!.id).not.toBe(refund!.id);
    await settleRefund(db, retry!.id, 'succeeded');
    await settleRefund(db, retry!.id, 'succeeded');
    expect(
      (
        await db
          .prepare("SELECT status FROM returns WHERE id='safety-return'")
          .first<{ status: string }>()
      )?.status
    ).toBe('refunded');
  } finally {
    spy.mockRestore();
  }
});
it('parallel checkouts enforce caps without leaking holds or ledger writes', async () => {
  const attempts = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      createPendingOrder(db, {
        email: 'same-cap@test.com',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      })
    )
  );
  expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
  for (const result of attempts)
    if (result.status === 'fulfilled') await cancelOrderById(db, result.value.orderId);
  await expectLedgerMatchesCounters(db, 'TEE-1');
  expect(normalizeNetwork('2001:db8:1:2::123')).toBe(normalizeNetwork('2001:0db8:0001:0002::456'));
});
it('a free rate is explicit and country eligibility cannot be bypassed', async () => {
  expect(await calculateShipping(db, 'test-rate', 2000, 1000, 'US')).toBe(0);
  await expect(calculateShipping(db, 'test-rate', 2000, 1000, 'CA')).rejects.toThrow(/country/);
  await expect(calculateShipping(db, undefined, 2000, 1000, 'US')).rejects.toThrow(/shipping/);
});
it('poison inbox payloads cap and create one durable owner alert', async () => {
  await db
    .prepare("INSERT INTO settings VALUES('operational_alert_email','ops@test.com',?)")
    .bind(new Date().toISOString())
    .run();
  await db
    .prepare(
      "INSERT INTO webhook_inbox(id,event_id,type,payload_json,received_at) VALUES('poison','poison','refund.updated','bad json',?)"
    )
    .bind(new Date().toISOString())
    .run();
  for (let i = 0; i < 6; i++) {
    await db.prepare("UPDATE webhook_inbox SET retry_after=NULL WHERE event_id='poison'").run();
    await processInboxEvent(db, 'poison', provider);
  }
  expect(
    (
      await db
        .prepare("SELECT attempts FROM webhook_inbox WHERE event_id='poison'")
        .first<{ attempts: number }>()
    )?.attempts
  ).toBe(5);
  expect(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM outbox WHERE id LIKE 'inbox-alert-poison-%'")
        .first<{ n: number }>()
    )?.n
  ).toBe(1);
});
it('private state is stripped before public rendering and cookie-setting responses stay private', () => {
  const base = { headers: { accept: 'text/html' } };
  expect(publicCacheRequest(new Request('https://shop.test/products/tee', base))).not.toBeNull();
  for (const path of [
    '/admin',
    '/account',
    '/cart',
    '/checkout',
    '/_serverFn/test',
    '/api/checkout',
  ])
    expect(publicCacheRequest(new Request(`https://shop.test${path}`, base))).toBeNull();
  // Shoppers with carts or sessions still get the shared cached page:
  // their private headers never reach the cached render.
  for (const key of ['cookie', 'authorization'] as const) {
    const forwarded = publicCacheRequest(
      new Request('https://shop.test/', {
        headers: { accept: 'text/html', [key]: 'private-value' },
      })
    );
    expect(forwarded).not.toBeNull();
    expect(forwarded!.headers.has('cookie')).toBe(false);
    expect(forwarded!.headers.has('authorization')).toBe(false);
  }
  expect(
    privateResponse(
      new Request('https://shop.test/'),
      new Response('x', { headers: { 'set-cookie': 'x=1' } })
    )
  ).toBe(true);
});
it('one event manifest covers all payload validators, including refund lifecycle subscriptions', () => {
  expect(new Set(Object.keys(handledStripeSchemas))).toEqual(new Set(REQUIRED_STRIPE_EVENTS));
  expect(missingStripeSubscriptions(['refund.updated'])).toContain('refund.failed');
  expect(missingStripeSubscriptions([...REQUIRED_STRIPE_EVENTS])).toEqual([]);
});

it('refund and dispute events arriving before Checkout resolve the order and cannot be overwritten by stale events', async () => {
  const o = await order('refund-first');
  const lookup = {
    ...provider,
    async findCheckoutSessionIdByPaymentIntent() {
      return 'cs_refund-first';
    },
  };
  const charge = JSON.stringify({
    id: 'evt_charge_first',
    type: 'charge.refunded',
    data: {
      object: {
        id: 'ch_first',
        payment_intent: 'pi_refund-first',
        amount_refunded: o.totalCents,
        refunds: {
          data: [
            {
              id: 're_first',
              payment_intent: 'pi_refund-first',
              amount: o.totalCents,
              status: 'succeeded',
            },
          ],
        },
      },
    },
  });
  await deliverStripeEvent(db, lookup, charge, 'test');
  await deliverStripeEvent(db, lookup, event(o, 'refund-first'), 'test');
  expect(
    (
      await db
        .prepare('SELECT payment_status FROM orders WHERE id=?')
        .bind(o.orderId)
        .first<{ payment_status: string }>()
    )?.payment_status
  ).toBe('refunded');
  expect(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM reservations WHERE order_id=? AND status='committed'")
        .bind(o.orderId)
        .first<{ n: number }>()
    )?.n
  ).toBe(0);
  const d = await order('dispute-first');
  const disputeLookup = {
    ...provider,
    async findCheckoutSessionIdByPaymentIntent() {
      return 'cs_dispute-first';
    },
  };
  const delivery = (id: string, type: string, status?: string) =>
    JSON.stringify({
      id,
      type,
      data: {
        object: {
          id: 'dp_first',
          payment_intent: 'pi_dispute-first',
          ...(status ? { status } : {}),
        },
      },
    });
  await deliverStripeEvent(
    db,
    disputeLookup,
    delivery('evt_closed_first', 'charge.dispute.closed', 'won'),
    'test'
  );
  await deliverStripeEvent(
    db,
    disputeLookup,
    delivery('evt_created_late', 'charge.dispute.created'),
    'test'
  );
  await deliverStripeEvent(db, disputeLookup, event(d, 'dispute-first'), 'test');
  expect(
    (
      await db
        .prepare('SELECT payment_status FROM orders WHERE id=?')
        .bind(d.orderId)
        .first<{ payment_status: string }>()
    )?.payment_status
  ).toBe('paid');
  await expectLedgerMatchesCounters(db, 'TEE-1');
});
it('return approval moves no money, does not restock, and support can approve', async () => {
  const o = await paid('return-no-refund');
  await db
    .prepare(
      "INSERT INTO returns(id,order_id,reason,created_at) VALUES('no-refund-return',?,'test',?)"
    )
    .bind(o.orderId, new Date().toISOString())
    .run();
  const before = (await expectLedgerMatchesCounters(db, 'TEE-1')).on_hand;
  const payload = { returnId: 'no-refund-return' };
  expect(
    await runAdminAction(
      db,
      {} as never,
      { id: 'support', role: 'support' },
      'return.approve',
      payload
    )
  ).toMatchObject({ ok: true });
  expect((await expectLedgerMatchesCounters(db, 'TEE-1')).on_hand).toBe(before);
  await runAdminAction(db, {} as never, { id: 'owner', role: 'owner' }, 'return.approve', payload);
  expect((await expectLedgerMatchesCounters(db, 'TEE-1')).on_hand).toBe(before);
  expect(
    (await db.prepare('SELECT COUNT(*) AS n FROM refunds WHERE order_id=?').bind(o.orderId).first())
      ?.n
  ).toBe(0);
  expect(
    (
      await db
        .prepare('SELECT payment_status FROM orders WHERE id=?')
        .bind(o.orderId)
        .first<{ payment_status: string }>()
    )?.payment_status
  ).toBe('paid');
});
it('zero-stock backorders can complete payment with a matching negative inventory ledger', async () => {
  await db.prepare("UPDATE variants SET continue_selling=1 WHERE sku='TEE-1'").run();
  const stock = await db
    .prepare("SELECT on_hand FROM stock WHERE sku='TEE-1'")
    .first<{ on_hand: number }>();
  const { adjustStock } = await import('../web/src/server/inventory');
  await adjustStock(db, 'TEE-1', -stock!.on_hand, 'correction');
  const o = await paid('backorder-paid');
  expect((await expectLedgerMatchesCounters(db, 'TEE-1')).on_hand).toBe(-1);
  expect(
    (
      await db
        .prepare('SELECT status FROM orders WHERE id=?')
        .bind(o.orderId)
        .first<{ status: string }>()
    )?.status
  ).toBe('paid');
  await expect(
    db.prepare("UPDATE variants SET continue_selling=0 WHERE sku='TEE-1'").run()
  ).rejects.toThrow(/backorders/);
});

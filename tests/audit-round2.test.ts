import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deliverStripeEvent } from './helpers/webhook';
import { createTestDb, seedProduct, expectLedgerMatchesCounters } from './helpers/d1';
import { quoteOrder, cancelOrderById, calculateDiscount } from '../web/src/server/checkout';
import { attachStripeSession } from './helpers/attach-session';
import { requestRefund, settleRefund } from '../web/src/server/refunds';
import { runAdminAction } from '../web/src/server/admin-actions';
import { adminActionSchema } from '../web/src/schemas/admin';
import { setSetting } from '../web/src/server/settings';
import * as settings from '../web/src/server/settings';
import { handleCheckoutRequest } from '../web/src/routes/api/checkout';
import { fakeAdmissionNamespace } from './helpers/admission';
import { checkoutCart, reviewSession } from './helpers/checkout-review';
import { addCartLine, cartCookieHeader, ensureCart } from '../web/src/server/cart';
import { heldOrder } from './helpers/pending-intent';
vi.mock('../web/src/server/session', () => ({ getSessionUser: async () => null }));
vi.mock('../web/src/server/turnstile', () => ({ verifyTurnstile: async () => true }));

const provider = {
  createCheckout: vi.fn(),
  createCheckoutCustomer: vi.fn(async () => 'cus_fixture'),
  retrieveCheckoutSession: (id: string) => reviewSession(db, id),
  async verifyWebhook(payload: string) {
    const event = JSON.parse(payload);
    return { ...event, data: event.data.object };
  },
  refund: vi.fn(async (_pi: string, _amount: number | undefined, key: string) => ({
    id: `re_${key}`,
    status: 'pending',
  })),
};
vi.mock('../web/src/server/payments', () => ({ getStripeProvider: () => provider }));
let db: D1Database, dispose: () => Promise<void>;
const actor = { id: 'owner', role: 'owner' };
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 20 });
  await db
    .prepare(
      "INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES('owner','Owner','owner@example.invalid','owner',0,0)"
    )
    .run();
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await dispose();
});
async function coupon(value = 10, usageLimit: number | null = null, perCustomer = 1) {
  await db
    .prepare(
      "INSERT INTO discounts(id,code,type,value,usage_limit,usage_per_customer,created_at) VALUES('coupon','SAVE','percentage',?,?,?,?)"
    )
    .bind(value, usageLimit, perCustomer, new Date().toISOString())
    .run();
}
async function order(name: string, discountCode?: string) {
  const result = await heldOrder(db, {
    email: `${name}@example.invalid`,
    lines: [{ sku: 'TEE-1', qty: 1 }],
    shippingCountry: 'US',
    shippingRateId: 'test-rate',
    discountCode,
  });
  await attachStripeSession(db, result.orderId, `cs_${name}`);
  return result;
}
async function event(
  o: Awaited<ReturnType<typeof order>>,
  name: string,
  extra: Record<string, unknown> = {},
  type = 'checkout.session.completed',
  eventId = crypto.randomUUID()
) {
  const object = {
    id: `cs_${name}`,
    mode: 'payment',
    payment_status: 'paid',
    payment_intent: `pi_${name}`,
    amount_total: o.totalCents,
    currency: 'usd',
    metadata: { order_id: o.orderId },
    collected_information: {
      shipping_details: { name: 'Fixture', address: { line1: 'Fixture', country: 'US' } },
    },
    ...extra,
  };
  return deliverStripeEvent(
    db,
    provider,
    JSON.stringify({ id: eventId, type, data: { object } }),
    'test'
  );
}
async function row(o: { orderId: string }) {
  return db.prepare('SELECT status,payment_status FROM orders WHERE id=?').bind(o.orderId).first();
}
async function count(table: string) {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}
async function returnFor(o: { orderId: string }) {
  await db
    .prepare("INSERT INTO returns(id,order_id,reason,created_at) VALUES('return',?,'Fixture',?)")
    .bind(o.orderId, new Date().toISOString())
    .run();
}

it('fulfills a zero-total session without a PaymentIntent once, and permits non-monetary return approval', async () => {
  await coupon(100);
  const o = await order('free', 'SAVE');
  await event(o, 'free', { payment_status: 'no_payment_required', payment_intent: null });
  await event(o, 'free', { payment_status: 'no_payment_required', payment_intent: null });
  await cancelOrderById(db, o.orderId);
  expect(await row(o)).toEqual({ status: 'paid', payment_status: 'paid' });
  expect(await expectLedgerMatchesCounters(db, 'TEE-1')).toEqual({ on_hand: 19, reserved: 0 });
  expect(await count('outbox')).toBe(1);
  await returnFor(o);
  // Approval is non-monetary and does not restock; refunds go through return.refund.
  expect(
    (
      await runAdminAction(db, {} as never, { id: actor.id, role: 'manager' }, 'return.approve', {
        returnId: 'return',
      })
    ).ok
  ).toBe(true);
  expect((await db.prepare("SELECT status FROM returns WHERE id='return'").first())?.status).toBe(
    'approved'
  );
  expect(await expectLedgerMatchesCounters(db, 'TEE-1')).toEqual({ on_hand: 19, reserved: 0 });
  expect(await count('refunds')).toBe(0);
  expect(provider.refund).not.toHaveBeenCalled();
  await expect(
    requestRefund(db, provider, { orderId: o.orderId, requestId: 'zero-refund', purpose: 'staff' })
  ).rejects.toThrow();
});

it('rejects no_payment_required on a nonzero order and keeps the hold', async () => {
  const o = await order('not-free');
  await expect(
    event(o, 'not-free', { payment_status: 'no_payment_required', payment_intent: null })
  ).rejects.toThrow();
  expect((await row(o))?.status).toBe('pending_payment');
});

it('keeps stock and coupon capacity after a recoverable decline, then commits a successful retry once', async () => {
  await coupon(10, 1);
  const o = await order('decline', 'SAVE');
  await db
    .prepare('UPDATE orders SET stripe_payment_intent_id=? WHERE id=?')
    .bind('pi_decline', o.orderId)
    .run();
  await event(o, 'decline', { id: 'pi_decline' }, 'payment_intent.payment_failed');
  expect((await row(o))?.status).toBe('pending_payment');
  expect(await expectLedgerMatchesCounters(db, 'TEE-1')).toEqual({ on_hand: 20, reserved: 1 });
  expect(await count('discount_usage')).toBe(1);
  await expect(order('other', 'SAVE')).rejects.toThrow();
  await event(o, 'decline');
  await event(o, 'decline', { id: 'pi_decline' }, 'payment_intent.payment_failed');
  expect((await row(o))?.status).toBe('paid');
  expect(await count('discount_usage')).toBe(1);
  expect(await expectLedgerMatchesCounters(db, 'TEE-1')).toEqual({ on_hand: 19, reserved: 0 });
});

it.each(['checkout.session.expired', 'checkout.session.async_payment_failed'])(
  'releases coupon and hold on terminal %s',
  async (type) => {
    await coupon(10, 1);
    const o = await order('terminal', 'SAVE');
    await event(o, 'terminal', {}, type);
    expect((await row(o))?.status).toBe('canceled');
    expect(await count('discount_usage')).toBe(0);
    expect(await expectLedgerMatchesCounters(db, 'TEE-1')).toEqual({ on_hand: 20, reserved: 0 });
  }
);

it('allows usage_per_customer=2 and atomically rejects the third concurrent claim', async () => {
  await coupon(10, null, 2);
  const results = await Promise.allSettled(
    [1, 2, 3].map(() =>
      heldOrder(db, {
        email: 'repeat@example.invalid',
        discountCode: 'SAVE',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      })
    )
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  expect(await count('discount_usage')).toBe(2);
  expect(
    (await db.prepare("SELECT usage_count FROM discounts WHERE id='coupon'").first())?.usage_count
  ).toBe(2);
});

it('never converts a completed payment into a late-payment refund when recovery loses a race', async () => {
  const o = await order('completed');
  await event(o, 'completed');
  await requestRefund(db, provider, {
    orderId: o.orderId,
    requestId: 'late-loser',
    purpose: 'late_payment',
    amountCents: o.totalCents,
  });
  expect((await row(o))?.status).toBe('paid');
  expect(await count('refunds')).toBe(0);
  expect(provider.refund).not.toHaveBeenCalled();
});

it('refunds a late paid order if coupon capacity is now exhausted, without committing stock', async () => {
  await coupon(10, 1);
  const o = await order('exhausted', 'SAVE');
  await cancelOrderById(db, o.orderId);
  await order('winner', 'SAVE');
  await event(o, 'exhausted');
  await event(o, 'exhausted');
  expect((await row(o))?.status).toBe('canceled');
  expect(await count('refunds')).toBe(1);
  expect(provider.refund).toHaveBeenCalledTimes(1);
  expect(await expectLedgerMatchesCounters(db, 'TEE-1')).toEqual({ on_hand: 20, reserved: 1 });
  const refund = await db.prepare('SELECT id FROM refunds').first<{ id: string }>();
  await settleRefund(db, refund!.id, 'succeeded', 're_expired');
  const email = await db
    .prepare('SELECT payload_json FROM outbox WHERE id=?')
    .bind(`refund-${refund!.id}`)
    .first<{ payload_json: string }>();
  expect(email?.payload_json).toContain('could not be completed or was canceled');
  expect(email?.payload_json).not.toContain('items sold out');
});

it('cancels and notifies an unrecoverable free order once, with no zero refund', async () => {
  await coupon(100, 1);
  const o = await order('expired-free', 'SAVE');
  await cancelOrderById(db, o.orderId);
  await order('free-winner', 'SAVE');
  await event(o, 'expired-free', { payment_status: 'no_payment_required', payment_intent: null });
  await event(o, 'expired-free', { payment_status: 'no_payment_required', payment_intent: null });
  expect((await row(o))?.status).toBe('canceled');
  expect(await count('refunds')).toBe(0);
  expect(await count('outbox')).toBe(1);
  expect(provider.refund).not.toHaveBeenCalled();
});

it('enforces 0–100 percentage input and SQL boundaries without rewriting invalid legacy coupons', async () => {
  for (const value of [-1, 101]) {
    expect(
      adminActionSchema.safeParse({
        action: 'discount.create',
        code: 'BAD',
        type: 'percentage',
        value,
      }).success
    ).toBe(false);
    await expect(coupon(value)).rejects.toThrow();
  }
  for (const value of [0, 100]) {
    expect(
      adminActionSchema.safeParse({
        action: 'discount.create',
        code: 'OK',
        type: 'percentage',
        value,
      }).success
    ).toBe(true);
  }
  await coupon();
  await expect(
    db.prepare("UPDATE discounts SET value=101 WHERE id='coupon'").run()
  ).rejects.toThrow();
  await db.prepare("UPDATE discounts SET type='fixed_amount',value=100000 WHERE id='coupon'").run();
  expect((await calculateDiscount(db, 'SAVE', 2000, 'buyer@example.invalid'))?.amountCents).toBe(
    2000
  );
});

it('blocks currency changes while pending or permanently locked, but permits a change after cancellation', async () => {
  const o = await order('currency');
  await expect(setSetting(db, 'currency', 'EUR')).rejects.toThrow();
  expect(
    await runAdminAction(db, {} as never, actor, 'settings.set', { key: 'currency', value: 'EUR' })
  ).toMatchObject({ ok: false, status: 409 });
  await cancelOrderById(db, o.orderId);
  await setSetting(db, 'currency', 'EUR');
  await setSetting(db, 'currency', 'USD');
  await event(await order('currency-paid'), 'currency-paid');
  await expect(setSetting(db, 'currency', 'EUR')).rejects.toThrow();
  await expect(
    db.prepare("DELETE FROM settings WHERE key='currency_locked'").run()
  ).rejects.toThrow();
});

it('allows an unchanged currency write while locked, but still rejects an actual change', async () => {
  const o = await order('currency-unchanged');
  await event(o, 'currency-unchanged');
  expect(
    await runAdminAction(db, {} as never, actor, 'settings.set', { key: 'currency', value: 'USD' })
  ).toMatchObject({ ok: true });
  expect(
    await runAdminAction(db, {} as never, actor, 'settings.set', { key: 'currency', value: 'EUR' })
  ).toMatchObject({ ok: false, status: 409 });
});

it('rejects an order inserted from a stale-currency quote without retaining a coupon or hold', async () => {
  await coupon();
  const original = db.batch.bind(db);
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          await setSetting(db, 'currency', 'EUR');
          return original(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    heldOrder(wrapped, {
      email: 'stale@example.invalid',
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      discountCode: 'SAVE',
      lines: [{ sku: 'TEE-1', qty: 1 }],
    })
  ).rejects.toThrow(/currency/i);
  expect(await count('orders')).toBe(0);
  expect(await count('discount_usage')).toBe(0);
  expect(await expectLedgerMatchesCounters(db, 'TEE-1')).toEqual({ on_hand: 20, reserved: 0 });
});

it.each(['return.reject', 'return.approve'])(
  'blocks %s without refund while a refund is pending',
  async (action) => {
    const o = await order('return');
    await event(o, 'return');
    await returnFor(o);
    await requestRefund(db, provider, {
      orderId: o.orderId,
      requestId: 'return-op',
      purpose: 'return',
      returnId: 'return',
    });
    const result = await runAdminAction(db, {} as never, actor, action, {
      returnId: 'return',
      refund: false,
      restock: true,
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((await db.prepare("SELECT status FROM returns WHERE id='return'").first())?.status).toBe(
      'requested'
    );
    await settleRefund(db, 'return-op', 'succeeded', 're_return');
    expect((await db.prepare("SELECT status FROM returns WHERE id='return'").first())?.status).toBe(
      'refunded'
    );
  }
);

it('rejects refund insertion after return rejection wins', async () => {
  const o = await order('rejected');
  await event(o, 'rejected');
  await returnFor(o);
  await runAdminAction(db, {} as never, actor, 'return.reject', { returnId: 'return' });
  await expect(
    requestRefund(db, provider, {
      orderId: o.orderId,
      requestId: 'too-late',
      purpose: 'return',
      returnId: 'return',
    })
  ).rejects.toThrow();
  expect(await count('refunds')).toBe(0);
  expect(provider.refund).not.toHaveBeenCalled();
});

it('serializes return rejection against refund creation without charging after rejection', async () => {
  const o = await order('race');
  await event(o, 'race');
  await returnFor(o);
  const [refund, rejection] = await Promise.allSettled([
    requestRefund(db, provider, {
      orderId: o.orderId,
      requestId: 'racing',
      purpose: 'return',
      returnId: 'return',
    }),
    runAdminAction(db, {} as never, actor, 'return.reject', { returnId: 'return' }),
  ]);
  const ret = await db.prepare("SELECT status FROM returns WHERE id='return'").first();
  if (ret?.status === 'rejected') {
    expect(refund.status).toBe('rejected');
    expect(provider.refund).not.toHaveBeenCalled();
    expect(await count('refunds')).toBe(0);
  } else {
    expect(ret?.status).toBe('requested');
    expect(refund.status).toBe('fulfilled');
    expect(rejection).toMatchObject({ status: 'fulfilled', value: { ok: false, status: 409 } });
  }
});

it('uses persisted order currency even if a subsequent settings read differs', async () => {
  const cart = await checkoutCart(db);
  const original = settings.getSettings;
  vi.spyOn(settings, 'getSettings').mockImplementation(async (database) => {
    const result = await original(database);
    return { ...result, currency: (await count('orders')) ? 'EUR' : 'USD' };
  });
  provider.createCheckout.mockResolvedValue({
    sessionId: 'cs_route',
    url: 'https://checkout.stripe.invalid/fixture',
  });
  const response = await handleCheckoutRequest(
    new Request('http://localhost:8799/api/checkout', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `guest_checkout=audit-route; ${cart.cookie}`,
      },
      body: JSON.stringify({
        intentId: '123e4567-e89b-42d3-a456-426614174001',
        ...cart,
        quoteRevision: (
          await quoteOrder(db, {
            email: 'route@example.invalid',
            lines: [{ sku: 'TEE-1', qty: 1 }],
            shippingCountry: 'US',
            shippingRateId: 'test-rate',
          })
        ).configRevision,
        confirmedQuote: await quoteOrder(db, {
          email: 'route@example.invalid',
          lines: [{ sku: 'TEE-1', qty: 1 }],
          shippingCountry: 'US',
          shippingRateId: 'test-rate',
        }),
        email: 'route@example.invalid',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      }),
    }),
    {
      DB: db,
      CHECKOUT_ADMISSION: fakeAdmissionNamespace({
        admission_starts_per_second: 100,
        admission_burst: 200,
        admission_max_active: 200,
      }).namespace,
    } as never
  );
  expect(response.status).toBe(200);
  expect(provider.createCheckout).toHaveBeenCalledWith(
    expect.objectContaining({ currency: 'USD' }),
    expect.objectContaining({ timeoutMs: expect.any(Number) })
  );
});

it('preparing checkout preserves the cart and does not run conversion cleanup', async () => {
  const cart = await ensureCart(db, null);
  await addCartLine(db, cart.creds, 'TEE-1', 1);
  const identity = await db
    .prepare('SELECT revision FROM carts WHERE id=?')
    .bind(cart.creds.id)
    .first<{ revision: number }>();
  provider.createCheckout.mockResolvedValue({
    sessionId: 'cs_convert_fail',
    url: 'https://checkout.stripe.invalid/convert-fail',
  });
  const proxied = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          if (/UPDATE.*carts.*converted/i.test(sql)) throw new Error('cart store unavailable');
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const response = await handleCheckoutRequest(
    new Request('http://localhost:8799/api/checkout', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${cartCookieHeader(cart.creds)}; guest_checkout=audit-route`,
      },
      body: JSON.stringify({
        intentId: '123e4567-e89b-42d3-a456-426614174002',
        cartId: cart.creds.id,
        cartRevision: identity!.revision,
        shippingAddress: {
          name: 'Fixture',
          line1: '1 Test St',
          city: 'New York',
          state: 'NY',
          postalCode: '10001',
          country: 'US',
        },
        quoteRevision: (
          await quoteOrder(db, {
            email: 'route@example.invalid',
            lines: [{ sku: 'TEE-1', qty: 1 }],
            shippingCountry: 'US',
            shippingRateId: 'test-rate',
          })
        ).configRevision,
        confirmedQuote: await quoteOrder(db, {
          email: 'route@example.invalid',
          lines: [{ sku: 'TEE-1', qty: 1 }],
          shippingCountry: 'US',
          shippingRateId: 'test-rate',
        }),
        email: 'route@example.invalid',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      }),
    }),
    {
      DB: proxied,
      CHECKOUT_ADMISSION: fakeAdmissionNamespace({
        admission_starts_per_second: 100,
        admission_burst: 200,
        admission_max_active: 200,
      }).namespace,
    } as never
  );
  expect(response.status).toBe(200);
  expect((await response.json()).state).toBe('review_ready');
  const cookies = response.headers.getSetCookie().join(';');
  expect(cookies).not.toContain('Max-Age=0');
  expect(
    await db.prepare('SELECT status FROM carts WHERE id=?').bind(cart.creds.id).first()
  ).toMatchObject({ status: 'open' });
});

it('baseline keeps populated coupons and claims intact, and leaves invalid old coupons unredeemable', async () => {
  await dispose();
  ({ db, dispose } = await createTestDb());
  await seedProduct(db);
  // The baseline guard rejects the invalid 125% coupon outright; the
  // calculation must still treat it as unredeemable below.
  await expect(coupon(125)).rejects.toThrow(/between 0 and 100/);
  await db.batch([
    db.prepare(
      "INSERT INTO discounts(id,code,type,value,usage_count,created_at) VALUES('historical','HISTORY','percentage',10,7,'2020-01-01')"
    ),
    db.prepare(
      "INSERT INTO orders(id,number,customer_email,discount_id,discount_cents,subtotal_cents,total_cents,created_at,updated_at) VALUES('history-order','HISTORY','history@example.invalid','historical',200,2000,1800,'2020-01-01','2020-01-01')"
    ),
    db.prepare(
      "INSERT INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES('history-item','history-order','TEE-1','Fixture',1,2000)"
    ),
    db.prepare(
      "INSERT INTO discount_usage(id,discount_id,order_id,customer_email,amount_cents,created_at) VALUES('history-claim','historical','history-order','history@example.invalid',200,'2020-01-01')"
    ),
  ]);
  const tables = ['discounts', 'discount_usage', 'orders', 'order_items'];
  const before = await Promise.all(
    tables.map(async (table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results)
  );
  expect(
    await Promise.all(
      tables.map(async (table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results)
    )
  ).toEqual(before);
  expect(await calculateDiscount(db, 'SAVE', 2000, 'legacy@example.invalid')).toBeNull();
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});

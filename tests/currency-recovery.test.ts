import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deliverStripeEvent } from './helpers/webhook';
import { createTestDb, seedProduct, expectLedgerMatchesCounters } from './helpers/d1';
import { createPendingOrder, cancelOrderById } from '../web/src/server/checkout';
import { attachStripeSession } from './helpers/attach-session';
import { setSetting } from '../web/src/server/settings';
import { settleRefund, requestRefund } from '../web/src/server/refunds';
import { paidRevenueByCurrency, monetaryReportQueries } from '../web/src/server/reports';
let db: D1Database, dispose: () => Promise<void>;
const provider = {
  createCheckout: vi.fn(),
  verifyWebhook: async (payload: string) => {
    const e = JSON.parse(payload);
    return { ...e, data: e.data.object };
  },
  refund: vi.fn(async () => ({ id: 're_currency', status: 'pending' })),
};
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 20 });
  provider.refund.mockReset().mockResolvedValue({ id: 're_currency', status: 'pending' });
});
afterEach(async () => {
  await dispose();
});
async function checkout(free = false) {
  if (free) await db.prepare('UPDATE variants SET price_cents=0').run();
  const o = await createPendingOrder(db, {
    email: 'fixture@example.invalid',
    shippingCountry: 'US',
    shippingRateId: 'test-rate',
    lines: [{ sku: 'TEE-1', qty: 1 }],
  });
  await attachStripeSession(db, o.orderId, 'cs_currency');
  return o;
}
async function event(
  o: Awaited<ReturnType<typeof checkout>>,
  free = false,
  eventId = crypto.randomUUID(),
  eventType = 'checkout.session.completed'
) {
  return deliverStripeEvent(
    db,
    provider as never,
    JSON.stringify({
      id: eventId,
      type: eventType,
      data: {
        object: {
          id: 'cs_currency',
          mode: 'payment',
          payment_status: free ? 'no_payment_required' : 'paid',
          payment_intent: free ? null : 'pi_currency',
          amount_total: o.totalCents,
          currency: 'usd',
          metadata: { order_id: o.orderId },
          collected_information: {
            shipping_details: { name: 'Fixture', address: { line1: 'Fixture', country: 'US' } },
          },
        },
      },
    }),
    'fixture'
  );
}
async function currencies() {
  return (
    await db
      .prepare(
        "SELECT key,value FROM settings WHERE key IN ('currency','currency_locked') ORDER BY key"
      )
      .all()
  ).results;
}
it('refunds a late old-currency payment once without committing stock, receipt or currency lock', async () => {
  const o = await checkout();
  await cancelOrderById(db, o.orderId);
  await setSetting(db, 'currency', 'EUR');
  await event(o);
  await event(o, false, crypto.randomUUID(), 'checkout.session.async_payment_succeeded');
  expect(
    await db.prepare('SELECT status,currency FROM orders WHERE id=?').bind(o.orderId).first()
  ).toEqual({ status: 'canceled', currency: 'USD' });
  expect(await db.prepare('SELECT purpose,recovery_reason,status FROM refunds').first()).toEqual({
    purpose: 'late_payment',
    recovery_reason: 'currency_changed',
    status: 'pending',
  });
  expect(provider.refund).toHaveBeenCalledTimes(1);
  expect(provider.refund).toHaveBeenCalledWith('pi_currency', o.totalCents, `late-${o.orderId}`);
  expect(
    (await db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE id LIKE 'receipt-%'").first())?.n
  ).toBe(0);
  expect(await currencies()).toEqual([{ key: 'currency', value: 'EUR' }]);
  expect(await expectLedgerMatchesCounters(db, 'TEE-1')).toEqual({ on_hand: 20, reserved: 0 });
});
it.each(['pending', 'failed', 'uncertain', 'succeeded'])(
  'retains the currency recovery reason through %s settlement and retry',
  async (status) => {
    const o = await checkout();
    await cancelOrderById(db, o.orderId);
    await setSetting(db, 'currency', 'EUR');
    if (status === 'uncertain')
      provider.refund.mockRejectedValueOnce(new Error('provider unavailable'));
    if (status === 'uncertain') await expect(event(o)).rejects.toThrow();
    else await event(o);
    if (status !== 'uncertain') await settleRefund(db, `late-${o.orderId}`, status, 're_currency');
    await requestRefund(db, provider as never, {
      orderId: o.orderId,
      amountCents: o.totalCents,
      requestId: `late-${o.orderId}`,
      purpose: 'late_payment',
    });
    expect((await db.prepare('SELECT recovery_reason FROM refunds').first())?.recovery_reason).toBe(
      'currency_changed'
    );
    expect(await currencies()).toEqual([{ key: 'currency', value: 'EUR' }]);
    if (status === 'succeeded')
      expect(
        JSON.parse(
          (await db
            .prepare('SELECT payload_json FROM outbox WHERE id=?')
            .bind(`refund-late-${o.orderId}`)
            .first<{ payload_json: string }>())!.payload_json
        ).text
      ).toMatch(/currency/);
  }
);
it('cancels an old-currency zero-total session and notifies once without refunding', async () => {
  const o = await checkout(true);
  await cancelOrderById(db, o.orderId);
  await setSetting(db, 'currency', 'EUR');
  await event(o, true);
  await event(o, true);
  expect(
    (await db.prepare('SELECT status FROM orders WHERE id=?').bind(o.orderId).first())?.status
  ).toBe('canceled');
  expect(provider.refund).not.toHaveBeenCalled();
  expect((await db.prepare('SELECT COUNT(*) AS n FROM refunds').first())?.n).toBe(0);
  const rows = await db
    .prepare("SELECT payload_json FROM outbox WHERE id LIKE 'expired-free-%'")
    .all<{ payload_json: string }>();
  expect(rows.results).toHaveLength(1);
  expect(JSON.parse(rows.results[0]!.payload_json).text).toMatch(/currency/);
  expect(await currencies()).toEqual([{ key: 'currency', value: 'EUR' }]);
});
it('serializes currency changes against payment and preserves a completed winner', async () => {
  const o = await checkout();
  await event(o);
  await expect(setSetting(db, 'currency', 'EUR')).rejects.toThrow();
  await event(o);
  expect((await db.prepare('SELECT COUNT(*) AS n FROM refunds').first())?.n).toBe(0);
  expect(
    (await db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE id LIKE 'receipt-%'").first())?.n
  ).toBe(1);
  expect(await expectLedgerMatchesCounters(db, 'TEE-1')).toEqual({ on_hand: 19, reserved: 0 });
});
it('captures the rejection reason in the transaction even when settings subsequently change again', async () => {
  const o = await checkout();
  await cancelOrderById(db, o.orderId);
  await setSetting(db, 'currency', 'EUR');
  const original = db.batch.bind(db);
  let changed = false;
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (stmts: D1PreparedStatement[]) => {
          const result = await original(stmts);
          if (!changed) {
            changed = true;
            await setSetting(db, 'currency', 'USD');
          }
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await deliverStripeEvent(
    wrapped as never,
    provider as never,
    JSON.stringify({
      id: 'evt_race',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_currency',
          mode: 'payment',
          payment_status: 'paid',
          payment_intent: 'pi_currency',
          amount_total: o.totalCents,
          currency: 'usd',
          metadata: { order_id: o.orderId },
          collected_information: {
            shipping_details: { name: 'Fixture', address: { line1: 'Fixture', country: 'US' } },
          },
        },
      },
    }),
    'fixture'
  );
  expect((await db.prepare('SELECT recovery_reason FROM refunds').first())?.recovery_reason).toBe(
    'currency_changed'
  );
});
it('a concurrent currency change and late payment produce either fulfillment in USD or a currency refund', async () => {
  const o = await checkout();
  await cancelOrderById(db, o.orderId);
  await Promise.allSettled([event(o), setSetting(db, 'currency', 'EUR')]);
  const order = await db
    .prepare('SELECT status FROM orders WHERE id=?')
    .bind(o.orderId)
    .first<{ status: string }>();
  const settings = await currencies();
  if (order?.status === 'paid') {
    expect(settings).toContainEqual({ key: 'currency_locked', value: '1' });
    expect(settings.some((row) => row.key === 'currency' && row.value === 'EUR')).toBe(false);
    expect(provider.refund).not.toHaveBeenCalled();
  } else {
    expect(order?.status).toBe('canceled');
    expect(settings).toEqual([{ key: 'currency', value: 'EUR' }]);
    expect((await db.prepare('SELECT recovery_reason FROM refunds').first())?.recovery_reason).toBe(
      'currency_changed'
    );
  }
});
it('excludes unfulfilled recovery payments from gross revenue and exports', async () => {
  const o = await checkout();
  await cancelOrderById(db, o.orderId);
  await setSetting(db, 'currency', 'EUR');
  await event(o);
  await settleRefund(db, `late-${o.orderId}`, 'failed', 're_currency');
  await db.batch([
    db.prepare(
      "INSERT INTO orders(id,number,status,payment_status,customer_email,currency,subtotal_cents,total_cents,created_at,updated_at) VALUES('eur','EUR','paid','paid','fixture@example.invalid','EUR',3000,3000,'2026','2026')"
    ),
    db.prepare(
      "INSERT INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES('eur-item','eur','TEE-1','Tee',1,3000)"
    ),
  ]);
  expect(await paidRevenueByCurrency(db)).toEqual([{ currency: 'EUR', revenue: 3000, orders: 1 }]);
  const products = await db.prepare(monetaryReportQueries.products).all();
  expect(products.results.map((r) => [r.currency, r.revenue_cents])).toEqual([['EUR', 3000]]);
  const customers = await db.prepare(monetaryReportQueries.customers).all();
  expect(customers.results.map((r) => [r.currency, r.spent_cents])).toEqual([['EUR', 3000]]);
});
it('database guards reject wrong-currency fulfillment and invalid or rewritten recovery reasons', async () => {
  const o = await checkout();
  await cancelOrderById(db, o.orderId);
  await setSetting(db, 'currency', 'EUR');
  await expect(
    db.prepare("UPDATE orders SET status='paid' WHERE id=?").bind(o.orderId).run()
  ).rejects.toThrow(/currency/);
  await event(o);
  await expect(
    db.prepare("UPDATE refunds SET recovery_reason='capacity_unavailable'").run()
  ).rejects.toThrow(/immutable/);
  await expect(
    db
      .prepare(
        "INSERT INTO refunds(id,order_id,amount_cents,purpose,recovery_reason,created_at) VALUES('invalid',?,1,'staff','currency_changed','2026')"
      )
      .bind(o.orderId)
      .run()
  ).rejects.toThrow();
});
it('baseline refunds default recovery_reason to null and keep prior data intact', async () => {
  await db
    .prepare(
      "INSERT INTO orders(id,number,status,payment_status,customer_email,subtotal_cents,total_cents,created_at,updated_at) VALUES('old','OLD','paid','paid','fixture@example.invalid',100,100,'2026','2026')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO refunds(id,request_id,order_id,amount_cents,status,created_at) VALUES('old-refund','old-refund','old',50,'pending','2026')"
    )
    .run();
  const row = await db.prepare('SELECT * FROM refunds').first<{ recovery_reason: string | null }>();
  expect(row?.recovery_reason).toBeNull();
});

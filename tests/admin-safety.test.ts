import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { deliverStripeEvent } from './helpers/webhook';
import { createTestDb, seedProduct } from './helpers/d1';
import { settleRefund } from '../web/src/server/refunds';
import { runAdminAction } from '../web/src/server/admin-actions';
import { failInboxEvent, reprocessStaleInbox } from '../web/src/server/checkout';
import { adjustStock, reserveStock, commitReservation } from '../web/src/server/inventory';
import {
  canShipOrder,
  availableRefundCents,
  calculatedReturnRefundCents,
  refundActionMessage,
  refundedQtyBefore,
} from '../web/src/lib/order-actions';
import { insertReturnRequest, validateReturnItems } from '../web/src/server/returns';
import { adminCustomers, adminOrders } from '../web/src/server/admin-lists';
import { adminProductDiscovery } from '../web/src/server/admin-product-discovery';
import { orderPagesSchema } from '../web/src/schemas/pagination';
import { heldOrder } from './helpers/pending-intent';

const provider = vi.hoisted(() => ({
  refund: vi.fn(async () => ({ id: 're_safety', status: 'pending' })),
  findRefundByOperation: vi.fn(async () => null),
}));
vi.mock('../web/src/server/payments', () => ({ getStripeProvider: () => provider }));
let db: D1Database, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  provider.refund.mockClear();
});
afterEach(async () => {
  await dispose();
});
async function order(id = 'o', payment = 'paid', status = 'paid') {
  await db
    .prepare(
      "INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,status,payment_status,stripe_payment_intent_id,created_at,updated_at) VALUES(?,?,'fixture@example.invalid',1000,1000,?,?,'pi_safety','2026','2026')"
    )
    .bind(id, id, status, payment)
    .run();
}
async function extraVariant() {
  await seedProduct(db, { onHand: 5 });
  await db
    .prepare(
      "INSERT INTO variants(id,product_id,sku,title,price_cents,created_at) VALUES('v2','p1','SECOND','Second',2000,'2026')"
    )
    .run();
}
function beforeBatch(inject: () => Promise<void>) {
  let once = false;
  return new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (stmts: D1PreparedStatement[]) => {
          if (!once) {
            once = true;
            await inject();
          }
          return target.batch(stmts);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
it('refund replay preserves disputes, shipping stays blocked, and a won dispute restores eligibility', async () => {
  await order('o', 'disputed', 'partially_refunded');
  await db
    .prepare(
      "INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,status,created_at) VALUES('r','r','o',200,'staff','succeeded','2026')"
    )
    .run();
  await settleRefund(db, 'r', 'succeeded');
  await settleRefund(db, 'r', 'succeeded');
  expect(
    (await db.prepare("SELECT payment_status FROM orders WHERE id='o'").first())?.payment_status
  ).toBe('disputed');
  expect(
    (
      await runAdminAction(db, {} as never, owner, 'order.ship', {
        orderId: 'o',
        trackingNumber: 'fixture',
      })
    ).ok
  ).toBe(false);
  const webhook = {
    verifyWebhook: async (payload: string) => {
      const event = JSON.parse(payload);
      return { ...event, data: event.data.object };
    },
  };
  await deliverStripeEvent(
    db,
    webhook as never,
    JSON.stringify({
      id: 'evt_won_safety',
      type: 'charge.dispute.closed',
      data: { object: { id: 'dp_safety', payment_intent: 'pi_safety', status: 'won' } },
    }),
    'fixture'
  );
  expect(
    (
      await runAdminAction(db, {} as never, owner, 'order.ship', {
        orderId: 'o',
        trackingNumber: 'fixture',
      })
    ).ok
  ).toBe(true);
});
it('checkout winning the deletion race preserves its variant, order, holds and stock', async () => {
  await extraVariant();
  const wrapped = beforeBatch(async () => {
    await heldOrder(db, {
      email: 'fixture@example.invalid',
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      lines: [{ sku: 'TEE-1', qty: 1 }],
    });
  });
  expect(
    (await runAdminAction(wrapped, {} as never, owner, 'variant.delete', { variantId: 'v1' })).ok
  ).toBe(false);
  expect((await db.prepare("SELECT reserved FROM stock WHERE sku='TEE-1'").first())?.reserved).toBe(
    1
  );
  expect(
    (await db.prepare("SELECT COUNT(*) n FROM reservations WHERE status='active'").first())?.n
  ).toBe(1);
  expect((await db.prepare("SELECT COUNT(*) n FROM variants WHERE id='v1'").first())?.n).toBe(1);
});
it('deletion reads the current stock correction and concurrent last-variant deletion cannot remove both', async () => {
  await extraVariant();
  const wrapped = beforeBatch(() => adjustStock(db, 'TEE-1', 2, 'restock'));
  expect(
    (await runAdminAction(wrapped, {} as never, owner, 'variant.delete', { variantId: 'v1' })).ok
  ).toBe(true);
  expect(
    (await db.prepare("SELECT SUM(delta_on_hand) n FROM stock_ledger WHERE sku='TEE-1'").first())?.n
  ).toBe(0);
  expect(
    (await runAdminAction(db, {} as never, owner, 'variant.delete', { variantId: 'v2' })).ok
  ).toBe(false);
});
it('attachment after the media deletion claim fails before storage work can break a reference', async () => {
  await db
    .prepare(
      "INSERT INTO media(id,r2_key,filename,content_type,created_at) VALUES('m','image.jpg','image.jpg','image/jpeg','2026')"
    )
    .run();
  let attachmentSucceeded = false;
  const remove = vi.fn(async () => {
    try {
      await db
        .prepare(
          "INSERT INTO posts(id,slug,title,status,cover_media_id,created_at,updated_at) VALUES('post','post','Post','published','m','2026','2026')"
        )
        .run();
      attachmentSucceeded = true;
    } catch {
      /* Expected database guard. */
    }
  });
  const result = await runAdminAction(
    db,
    { MEDIA: { delete: remove } } as never,
    owner,
    'media.delete',
    { mediaId: 'm' }
  );
  expect(result.ok).toBe(true);
  expect(attachmentSucceeded).toBe(false);
});
it('failed media deletion stays marked and manual retry finishes without allowing attachments', async () => {
  await db
    .prepare(
      "INSERT INTO media(id,r2_key,filename,content_type,created_at) VALUES('m','image.jpg','image.jpg','image/jpeg','2026')"
    )
    .run();
  const remove = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('storage unavailable'))
    .mockResolvedValue(undefined);
  const env = { MEDIA: { delete: remove } } as never;
  expect((await runAdminAction(db, env, owner, 'media.delete', { mediaId: 'm' })).ok).toBe(false);
  expect(
    (await db.prepare("SELECT deletion_pending FROM media WHERE id='m'").first())?.deletion_pending
  ).toBe(1);
  expect((await runAdminAction(db, env, owner, 'media.delete', { mediaId: 'm' })).ok).toBe(true);
  expect(await db.prepare("SELECT id FROM media WHERE id='m'").first()).toBeNull();
});
it('simultaneous last-two-variant deletes leave one variant, and deletion winning rejects a stale checkout', async () => {
  await extraVariant();
  const results = await Promise.all(
    ['v1', 'v2'].map((variantId) =>
      runAdminAction(db, {} as never, owner, 'variant.delete', { variantId })
    )
  );
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(
    (await db.prepare("SELECT COUNT(*) n FROM variants WHERE product_id='p1'").first())?.n
  ).toBe(1);
  const deleted = results[0].ok ? 'TEE-1' : 'SECOND';
  await expect(
    heldOrder(db, {
      email: 'fixture@example.invalid',
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      lines: [{ sku: deleted, qty: 1 }],
    })
  ).rejects.toThrow(/not active/);
  expect((await db.prepare('SELECT COUNT(*) n FROM orders').first())?.n).toBe(0);
});
it('a full refund can restock once without clearing an existing dispute', async () => {
  await seedProduct(db, { onHand: 5 });
  await order('o', 'disputed');
  const [hold] = await reserveStock(db, [{ sku: 'TEE-1', qty: 1 }], { orderId: 'o' });
  await commitReservation(db, hold);
  await db
    .prepare(
      "INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,status,restock,created_at) VALUES('r','r','o',1000,'staff','pending',1,'2026')"
    )
    .run();
  await settleRefund(db, 'r', 'succeeded');
  await settleRefund(db, 'r', 'succeeded');
  expect(
    (await db.prepare("SELECT payment_status FROM orders WHERE id='o'").first())?.payment_status
  ).toBe('disputed');
  expect((await db.prepare("SELECT on_hand FROM stock WHERE sku='TEE-1'").first())?.on_hand).toBe(
    5
  );
});
it('shipping eligibility and refund messages respect partial refunds, pending balances and currency', () => {
  expect(canShipOrder({ status: 'partially_refunded', payment_status: 'partially_refunded' })).toBe(
    true
  );
  expect(canShipOrder({ status: 'partially_refunded', payment_status: 'disputed' })).toBe(false);
  expect(availableRefundCents(1000, [{ amount_cents: 200, status: 'succeeded' }])).toBe(800);
  expect(
    availableRefundCents(1000, [
      { amount_cents: 200, status: 'succeeded' },
      { amount_cents: 300, status: 'pending' },
      { amount_cents: 100, status: 'uncertain' },
      { amount_cents: 100, status: 'failed' },
      { amount_cents: 100, status: 'canceled' },
    ])
  ).toBe(400);
  expect(refundActionMessage({ refundStatus: 'pending', amountCents: 800 }, 'EUR')).toContain(
    'Settlement has not completed'
  );
  expect(refundActionMessage({ refundStatus: 'succeeded', amountCents: 800 }, 'EUR')).toContain(
    'Refund completed: EUR'
  );
  expect(refundActionMessage({ refundStatus: 'failed', amountCents: 800 }, 'EUR')).toContain(
    'No refund completed'
  );
  for (const malformed of [
    null,
    'ok',
    { refundStatus: 'failed' },
    { refundStatus: 1, amountCents: 8 },
  ])
    expect(refundActionMessage(malformed, 'EUR')).toContain('Refund result unavailable');
});
it('pages tied timestamps and keeps older pending returns ahead of newer decided rows', async () => {
  await db.batch([
    db.prepare(
      "WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<101) INSERT INTO products(id,slug,title,created_at,updated_at) SELECT printf('p%03d',n),printf('p%03d',n),'P','2026','2026' FROM c"
    ),
    db.prepare(
      "WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<201) INSERT INTO user(id,name,email,created_at,updated_at) SELECT printf('u%03d',n),'Fixture',printf('u%03d@example.invalid',n),1,1 FROM c"
    ),
    db.prepare(
      "WITH RECURSIVE c(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM c WHERE n<101) INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,created_at,updated_at) SELECT printf('o%03d',n),printf('O%03d',n),'fixture@example.invalid',100,100,'2026','2026' FROM c"
    ),
    db.prepare(
      "INSERT INTO returns(id,order_id,status,created_at) SELECT id,id,CASE WHEN id<='o051' THEN 'requested' ELSE 'rejected' END,CASE WHEN id<='o051' THEN '2026' ELSE '2027' END FROM orders"
    ),
  ]);
  const first = await adminProductDiscovery(db, {});
  const second = await adminProductDiscovery(db, { cursor: first.nextCursor });
  const third = await adminProductDiscovery(db, { cursor: second.nextCursor });
  expect(first.products).toHaveLength(50);
  expect(second.products).toHaveLength(50);
  expect(third.products.map((p) => p.id)).toEqual(['p001']);
  expect(
    (await adminProductDiscovery(db, { cursor: third.previousCursor })).products.map((p) => p.id)
  ).toEqual(second.products.map((p) => p.id));
  expect(
    (await adminProductDiscovery(db, { cursor: second.previousCursor })).products.map((p) => p.id)
  ).toEqual(first.products.map((p) => p.id));
  expect((await adminCustomers(db, { page: 2 })).customers.map((u) => u.id)).toEqual(['u001']);
  const orders = await adminOrders(db, { page: 2, returnsPage: 2 });
  expect(orders.orders.map((o) => o.id)).toEqual(['o001']);
  expect(orders.returns.map((r) => r.id)).toEqual(['o051']);
  expect(orders.totalReturns).toBe(51);
  expect((await adminOrders(db, { page: 1, returnsPage: 1 })).returns[0].id).toBe('o001');
  for (const bad of [0, -1, 1.5, 'no', Number.MAX_SAFE_INTEGER])
    expect(orderPagesSchema.parse({ page: bad, returnsPage: bad })).toEqual({
      page: 1,
      returnsPage: 1,
    });
  expect((await adminProductDiscovery(db, { cursor: 'bad' })).products[0].id).toBe('p101');
});
it('baseline media defaults deletion_pending to 0 and stays FK-clean', async () => {
  await db
    .prepare(
      "INSERT INTO media(id,r2_key,filename,content_type,created_at) VALUES('m','old.jpg','old.jpg','image/jpeg','2026')"
    )
    .run();
  expect(
    await db.prepare("SELECT r2_key,deletion_pending FROM media WHERE id='m'").first()
  ).toEqual({ r2_key: 'old.jpg', deletion_pending: 0 });
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
it('return.refund refunds only the explicit confirmed balance and reports pending settlement', async () => {
  await order();
  await db
    .prepare(
      "INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,status,created_at) VALUES('previous','previous','o',200,'staff','succeeded','2026')"
    )
    .run();
  await db
    .prepare(
      "UPDATE orders SET payment_status='partially_refunded',status='partially_refunded' WHERE id='o'"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO returns(id,order_id,status,created_at) VALUES('r','o','requested','2026')"
    )
    .run();
  expect(
    (await runAdminAction(db, {} as never, owner, 'return.approve', { returnId: 'r' })).ok
  ).toBe(true);
  const result = await runAdminAction(db, {} as never, owner, 'return.refund', {
    returnId: 'r',
    amountCents: 600,
  });
  expect(result.ok).toBe(true);
  expect(provider.refund).toHaveBeenCalledWith('pi_safety', 600, 'return-r-0');
  expect(result.data).toMatchObject({ refundStatus: 'pending', amountCents: 600 });
  expect((await db.prepare("SELECT status FROM returns WHERE id='r'").first())?.status).toBe(
    'approved'
  );
});
it('return approval without refund moves no money and support can approve', async () => {
  await order();
  await db
    .prepare(
      "INSERT INTO returns(id,order_id,status,created_at) VALUES('r','o','requested','2026')"
    )
    .run();
  const support = { id: 'support', role: 'support' };
  const result = await runAdminAction(db, {} as never, support, 'return.approve', {
    returnId: 'r',
  });
  expect(result.ok).toBe(true);
  expect((await db.prepare("SELECT status FROM returns WHERE id='r'").first())?.status).toBe(
    'approved'
  );
  expect((await db.prepare('SELECT COUNT(*) AS n FROM refunds').first())?.n).toBe(0);
  expect(provider.refund).not.toHaveBeenCalled();
});
it('return.refund refunds exactly the confirmed amount and closes the return on settlement', async () => {
  await order();
  await db
    .prepare("INSERT INTO returns(id,order_id,status,created_at) VALUES('r','o','approved','2026')")
    .run();
  const result = await runAdminAction(db, {} as never, owner, 'return.refund', {
    returnId: 'r',
    amountCents: 800,
  });
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ refundStatus: 'pending', amountCents: 800 });
  expect(provider.refund).toHaveBeenCalledWith('pi_safety', 800, 'return-r-0');
  const refund = await db
    .prepare("SELECT id FROM refunds WHERE return_id='r'")
    .first<{ id: string }>();
  expect(refund?.id).toBeTruthy();
  await settleRefund(db, refund!.id, 'succeeded');
  expect((await db.prepare("SELECT status FROM returns WHERE id='r'").first())?.status).toBe(
    'refunded'
  );
});
it('return.refund rejects support and manager, requested returns, and live refunds', async () => {
  await order();
  await db
    .prepare("INSERT INTO returns(id,order_id,status,created_at) VALUES('r','o','approved','2026')")
    .run();
  for (const role of ['support', 'manager']) {
    const denied = await runAdminAction(db, {} as never, { id: role, role }, 'return.refund', {
      returnId: 'r',
      amountCents: 100,
    });
    expect(denied).toMatchObject({ ok: false, status: 403 });
  }
  await order('o2');
  await db
    .prepare(
      "INSERT INTO returns(id,order_id,status,created_at) VALUES('r2','o2','requested','2026')"
    )
    .run();
  expect(
    await runAdminAction(db, {} as never, owner, 'return.refund', {
      returnId: 'r2',
      amountCents: 100,
    })
  ).toMatchObject({ ok: false, status: 409 });
  await db
    .prepare(
      "INSERT INTO refunds(id,request_id,order_id,return_id,amount_cents,purpose,status,created_at) VALUES('live','live','o','r',100,'return','pending','2026')"
    )
    .run();
  expect(
    await runAdminAction(db, {} as never, owner, 'return.refund', {
      returnId: 'r',
      amountCents: 100,
    })
  ).toMatchObject({ ok: false, status: 409 });
  expect(provider.refund).not.toHaveBeenCalled();
});
it('general refunds are blocked while a return is open, in the action and in the database', async () => {
  await order();
  await db
    .prepare(
      "INSERT INTO returns(id,order_id,status,created_at) VALUES('r','o','requested','2026')"
    )
    .run();
  const blocked = await runAdminAction(db, {} as never, owner, 'order.refund', {
    orderId: 'o',
    requestId: 'req-open-1',
    amountCents: 100,
  });
  expect(blocked).toMatchObject({ ok: false, status: 409 });
  expect(blocked.ok === false && blocked.error).toContain('open return');
  await expect(
    db
      .prepare(
        "INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,status,created_at) VALUES('raw','raw','o',100,'staff','pending','2026')"
      )
      .run()
  ).rejects.toThrow(/open return/);
  expect(
    (await runAdminAction(db, {} as never, owner, 'return.reject', { returnId: 'r' })).ok
  ).toBe(true);
  const allowed = await runAdminAction(db, {} as never, owner, 'order.refund', {
    orderId: 'o',
    requestId: 'req-open-2',
    amountCents: 100,
  });
  expect(allowed.ok).toBe(true);
  await order('o2');
  await db
    .prepare(
      "INSERT INTO returns(id,order_id,status,created_at) VALUES('r2','o2','approved','2026')"
    )
    .run();
  expect(
    await runAdminAction(db, {} as never, owner, 'order.refund', {
      orderId: 'o2',
      requestId: 'req-open-3',
      amountCents: 100,
    })
  ).toMatchObject({ ok: false, status: 409 });
  await db.prepare("UPDATE returns SET status='refunded' WHERE id='r2'").run();
  expect(
    (
      await runAdminAction(db, {} as never, owner, 'order.refund', {
        orderId: 'o2',
        requestId: 'req-open-4',
        amountCents: 100,
      })
    ).ok
  ).toBe(true);
});
it('itemized return validation caps quantities at bought minus already returned', async () => {
  await order();
  await db.batch([
    db.prepare(
      "INSERT INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES('i1','o','TEE-1','Tee',2,1000)"
    ),
    db.prepare(
      "INSERT INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES('i2','o','MUG-1','Mug',1,500)"
    ),
    db.prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('u1','Fixture','fixture@example.invalid',1,'2026','2026')"
    ),
  ]);
  expect((await validateReturnItems(db, 'o', [{ orderItemId: 'i1', qty: 3 }])).ok).toBe(false);
  expect((await validateReturnItems(db, 'o', [{ orderItemId: 'nope', qty: 1 }])).ok).toBe(false);
  const first = await validateReturnItems(db, 'o', [{ orderItemId: 'i1', qty: 1 }]);
  expect(first.ok).toBe(true);
  if (first.ok) {
    const inserted = await insertReturnRequest(db, 'o', 'u1', 'too small', first.items);
    expect(inserted.ok).toBe(true);
  }
  expect((await db.prepare('SELECT COUNT(*) AS n FROM return_items').first())?.n).toBe(1);
  expect((await validateReturnItems(db, 'o', [{ orderItemId: 'i1', qty: 2 }])).ok).toBe(false);
  expect((await validateReturnItems(db, 'o', [{ orderItemId: 'i1', qty: 1 }])).ok).toBe(true);
});
it('dead-lettered webhooks park as dead, email once, and replay via the sweep', async () => {
  await db
    .prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES('operational_alert_email','ops@example.com','2026-01-01')"
    )
    .run();
  await db
    .prepare(
      `INSERT INTO webhook_inbox(id,provider,event_id,type,payload_json,status,attempts,retry_after,received_at)
       VALUES('wh1','stripe','evt_dead','unknown.event','{"id":"evt_dead","type":"unknown.event","data":{"object":{}}}','failed',3,'2020-01-01','2020-01-01')`
    )
    .run();
  await failInboxEvent(db, 'evt_dead', true);
  expect(
    (await db.prepare("SELECT status FROM webhook_inbox WHERE event_id='evt_dead'").first())?.status
  ).toBe('dead');
  const alertCount = async () =>
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM outbox WHERE id LIKE 'inbox-alert-evt_dead%'")
        .first<{ n: number }>()
    )?.n;
  expect(await alertCount()).toBe(1);
  await db
    .prepare("UPDATE webhook_inbox SET retry_after='2020-01-01' WHERE event_id='evt_dead'")
    .run();
  await reprocessStaleInbox(db, provider as never);
  expect(
    (await db.prepare("SELECT status FROM webhook_inbox WHERE event_id='evt_dead'").first())?.status
  ).toBe('processed');
  // A second dead-letter cycle for the same event cannot re-send the email.
  await db
    .prepare("UPDATE webhook_inbox SET status='failed',attempts=3 WHERE event_id='evt_dead'")
    .run();
  await failInboxEvent(db, 'evt_dead', true);
  expect(await alertCount()).toBe(1);
});
it('a replayed dead webhook that fails five more times parks as dead again with one email', async () => {
  await db
    .prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES('operational_alert_email','ops@example.com','2026-01-01')"
    )
    .run();
  await db
    .prepare(
      `INSERT INTO webhook_inbox(id,provider,event_id,type,payload_json,status,attempts,retry_after,received_at)
       VALUES('wh2','stripe','evt_dead2','unknown.event','{"id":"evt_dead2","type":"unknown.event","data":{"object":{}}}','dead',5,'2020-01-01','2020-01-01')`
    )
    .run();
  await failInboxEvent(db, 'evt_dead2', true);
  const alertCount = async () =>
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM outbox WHERE id LIKE 'inbox-alert-evt_dead2%'")
        .first<{ n: number }>()
    )?.n;
  expect(await alertCount()).toBe(1);
  await db
    .prepare(
      "UPDATE webhook_inbox SET status='pending',attempts=0,retry_after=NULL WHERE event_id='evt_dead2'"
    )
    .run();
  for (let i = 0; i < 5; i++) await failInboxEvent(db, 'evt_dead2');
  const row = await db
    .prepare("SELECT status,attempts FROM webhook_inbox WHERE event_id='evt_dead2'")
    .first<{ status: string; attempts: number }>();
  expect(row?.status).toBe('dead');
  expect(row?.attempts).toBe(5);
  expect(await alertCount()).toBe(1);
});
it('a refund that fails after succeeding marks the return refund_failed', async () => {
  await order();
  await db
    .prepare("INSERT INTO returns(id,order_id,status,created_at) VALUES('r','o','approved','2026')")
    .run();
  const result = await runAdminAction(db, {} as never, owner, 'return.refund', {
    returnId: 'r',
    amountCents: 800,
  });
  expect(result.ok).toBe(true);
  const refund = await db
    .prepare("SELECT id FROM refunds WHERE return_id='r'")
    .first<{ id: string }>();
  await settleRefund(db, refund!.id, 'succeeded');
  expect((await db.prepare("SELECT status FROM returns WHERE id='r'").first())?.status).toBe(
    'refunded'
  );
  await settleRefund(db, refund!.id, 'failed');
  expect((await db.prepare("SELECT status FROM returns WHERE id='r'").first())?.status).toBe(
    'refund_failed'
  );
});
it('a failed refund with a second open return settles cleanly and can be refunded again', async () => {
  await db
    .prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES('operational_alert_email','ops@example.com','2026-01-01')"
    )
    .run();
  await order();
  await db
    .prepare(
      "INSERT INTO returns(id,order_id,status,created_at) VALUES('ra','o','approved','2026')"
    )
    .run();
  const first = await runAdminAction(db, {} as never, owner, 'return.refund', {
    returnId: 'ra',
    amountCents: 400,
  });
  expect(first.ok).toBe(true);
  const refundA = await db
    .prepare("SELECT id FROM refunds WHERE return_id='ra'")
    .first<{ id: string }>();
  await settleRefund(db, refundA!.id, 'succeeded');
  expect((await db.prepare("SELECT status FROM returns WHERE id='ra'").first())?.status).toBe(
    'refunded'
  );
  expect(
    (await db.prepare("SELECT payment_status FROM orders WHERE id='o'").first())?.payment_status
  ).toBe('partially_refunded');
  await db
    .prepare(
      "INSERT INTO returns(id,order_id,status,created_at) VALUES('rb','o','requested','2026')"
    )
    .run();
  await settleRefund(db, refundA!.id, 'failed');
  expect((await db.prepare("SELECT status FROM returns WHERE id='ra'").first())?.status).toBe(
    'refund_failed'
  );
  expect((await db.prepare("SELECT status FROM returns WHERE id='rb'").first())?.status).toBe(
    'requested'
  );
  expect(
    (await db.prepare("SELECT payment_status FROM orders WHERE id='o'").first())?.payment_status
  ).toBe('paid');
  expect(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM outbox WHERE id LIKE 'refund-alert-%'")
        .first<{ n: number }>()
    )?.n
  ).toBeGreaterThan(0);
  // General refunds stay blocked while A is refund_failed.
  expect(
    await runAdminAction(db, {} as never, owner, 'order.refund', {
      orderId: 'o',
      requestId: 'req-blocked-failed',
      amountCents: 100,
    })
  ).toMatchObject({ ok: false, status: 409 });
  const retry = await runAdminAction(db, {} as never, owner, 'return.refund', {
    returnId: 'ra',
    amountCents: 400,
  });
  expect(retry.ok).toBe(true);
  const refundRetry = await db
    .prepare("SELECT id FROM refunds WHERE return_id='ra' AND status NOT IN ('failed','canceled')")
    .first<{ id: string }>();
  expect(refundRetry?.id).toBeTruthy();
  await settleRefund(db, refundRetry!.id, 'succeeded');
  expect((await db.prepare("SELECT status FROM returns WHERE id='ra'").first())?.status).toBe(
    'refunded'
  );
  expect(
    (await db.prepare("SELECT payment_status FROM orders WHERE id='o'").first())?.payment_status
  ).toBe('partially_refunded');
});
it('closing a refund_failed return frees the order for general refunds, owner only', async () => {
  await order();
  await db
    .prepare(
      "INSERT INTO returns(id,order_id,status,created_at) VALUES('rf','o','refund_failed','2026')"
    )
    .run();
  // Blocked while refund_failed is open.
  expect(
    await runAdminAction(db, {} as never, owner, 'order.refund', {
      orderId: 'o',
      requestId: 'req-close-1',
      amountCents: 100,
    })
  ).toMatchObject({ ok: false, status: 409 });
  // Queue and count include refund_failed.
  const queue = await adminOrders(db, { page: 1, returnsPage: 1 });
  expect(queue.returns.map((r) => r.id)).toContain('rf');
  expect(queue.totalReturns).toBe(1);
  // Support can reject requested returns but cannot close a failed refund.
  expect(
    await runAdminAction(db, {} as never, { id: 'support', role: 'support' }, 'return.reject', {
      returnId: 'rf',
    })
  ).toMatchObject({ ok: false, status: 403 });
  expect((await db.prepare("SELECT status FROM returns WHERE id='rf'").first())?.status).toBe(
    'refund_failed'
  );
  const closed = await runAdminAction(db, {} as never, owner, 'return.reject', {
    returnId: 'rf',
  });
  expect(closed.ok).toBe(true);
  expect((await db.prepare("SELECT status FROM returns WHERE id='rf'").first())?.status).toBe(
    'rejected'
  );
  const allowed = await runAdminAction(db, {} as never, owner, 'order.refund', {
    orderId: 'o',
    requestId: 'req-close-2',
    amountCents: 100,
  });
  expect(allowed.ok).toBe(true);
});
it('closing a refund_failed return with a live retry refund is refused, and the retry closes it', async () => {
  await order();
  await db
    .prepare(
      "INSERT INTO returns(id,order_id,status,created_at) VALUES('rf','o','refund_failed','2026')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO refunds(id,request_id,order_id,return_id,amount_cents,purpose,status,created_at) VALUES('retry','retry','o','rf',400,'return','pending','2026')"
    )
    .run();
  expect(
    await runAdminAction(db, {} as never, owner, 'return.reject', { returnId: 'rf' })
  ).toMatchObject({ ok: false, status: 409 });
  expect((await db.prepare("SELECT status FROM returns WHERE id='rf'").first())?.status).toBe(
    'refund_failed'
  );
  await settleRefund(db, 'retry', 'succeeded');
  expect((await db.prepare("SELECT status FROM returns WHERE id='rf'").first())?.status).toBe(
    'refunded'
  );
});
it('database guards both orders of the close versus retry race', async () => {
  await order();
  await db
    .prepare(
      "INSERT INTO returns(id,order_id,status,created_at) VALUES('rf','o','refund_failed','2026')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO refunds(id,request_id,order_id,return_id,amount_cents,purpose,status,created_at) VALUES('retry','retry','o','rf',400,'return','pending','2026')"
    )
    .run();
  // Refund first, close second: the unconditional update aborts in the DB.
  await expect(
    db.prepare("UPDATE returns SET status='rejected' WHERE id='rf'").run()
  ).rejects.toThrow(/active or successful/);
  expect((await db.prepare("SELECT status FROM returns WHERE id='rf'").first())?.status).toBe(
    'refund_failed'
  );
  // Close first, refund second: the insert guard refuses a refund on a
  // rejected return.
  await db.prepare("DELETE FROM refunds WHERE id='retry'").run();
  expect(
    (await runAdminAction(db, {} as never, owner, 'return.reject', { returnId: 'rf' })).ok
  ).toBe(true);
  await expect(
    db
      .prepare(
        "INSERT INTO refunds(id,request_id,order_id,return_id,amount_cents,purpose,status,created_at) VALUES('late','late','o','rf',400,'return','pending','2026')"
      )
      .run()
  ).rejects.toThrow(/return already decided/);
});
it('a delivered order keeps its fulfillment status through a full refund and its reversal', async () => {
  await order('o', 'paid', 'delivered');
  await db
    .prepare(
      "INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,status,created_at) VALUES('fr','fr','o',1000,'staff','pending','2026')"
    )
    .run();
  await settleRefund(db, 'fr', 'succeeded');
  let row = await db
    .prepare("SELECT status,payment_status FROM orders WHERE id='o'")
    .first<{ status: string; payment_status: string }>();
  expect(row).toEqual({ status: 'delivered', payment_status: 'refunded' });
  await settleRefund(db, 'fr', 'failed');
  row = await db
    .prepare("SELECT status,payment_status FROM orders WHERE id='o'")
    .first<{ status: string; payment_status: string }>();
  expect(row).toEqual({ status: 'delivered', payment_status: 'paid' });
  expect(canShipOrder(row!)).toBe(false);
});
it('a restocked order cannot ship after its refund reverses', async () => {
  await seedProduct(db, { onHand: 10 });
  await order('o', 'paid', 'paid');
  const [hold] = await reserveStock(db, [{ sku: 'TEE-1', qty: 2 }], { orderId: 'o' });
  await commitReservation(db, hold!);
  await db
    .prepare(
      "INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,status,restock,created_at) VALUES('r','r','o',1000,'staff','pending',1,'2026')"
    )
    .run();
  await settleRefund(db, 'r', 'succeeded');
  expect(
    (await db.prepare("SELECT restocked_at FROM orders WHERE id='o'").first())?.restocked_at
  ).toBeTruthy();
  expect((await db.prepare("SELECT on_hand FROM stock WHERE sku='TEE-1'").first())?.on_hand).toBe(
    10
  );
  await settleRefund(db, 'r', 'failed');
  const row = await db
    .prepare("SELECT status,payment_status,restocked_at FROM orders WHERE id='o'")
    .first<{ status: string; payment_status: string; restocked_at: string | null }>();
  expect(row?.payment_status).toBe('paid');
  expect(canShipOrder(row!)).toBe(false);
  const ship = await runAdminAction(db, {} as never, owner, 'order.ship', {
    orderId: 'o',
    trackingNumber: 'TRK1',
  });
  expect(ship).toMatchObject({ ok: false, status: 409 });
});
it('canceled and pending_payment orders keep fulfillment status through full refunds and reversals', async () => {
  for (const [id, status] of [
    ['c1', 'canceled'],
    ['p1', 'pending_payment'],
  ] as const) {
    await order(id, status === 'canceled' ? 'paid' : 'unpaid', status);
    await db
      .prepare(
        "INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,status,created_at) VALUES(?,?,?,1000,'late_payment','pending','2026')"
      )
      .bind(`rf-${id}`, `rf-${id}`, id)
      .run();
    await settleRefund(db, `rf-${id}`, 'succeeded');
    let row = await db
      .prepare('SELECT status,payment_status FROM orders WHERE id=?')
      .bind(id)
      .first<{ status: string; payment_status: string }>();
    expect(row).toEqual({ status, payment_status: 'refunded' });
    await settleRefund(db, `rf-${id}`, 'failed');
    row = await db
      .prepare('SELECT status,payment_status FROM orders WHERE id=?')
      .bind(id)
      .first<{ status: string; payment_status: string }>();
    // Settlement or reversal alone must not make the order shippable.
    expect(row?.status).toBe(status);
    expect(canShipOrder({ status: row!.status, payment_status: row!.payment_status })).toBe(false);
  }
});
it('stale validation cannot insert more returned units than were purchased', async () => {
  await order();
  await db.batch([
    db.prepare(
      "INSERT INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES('i1','o','TEE-1','Tee',2,1000)"
    ),
    db.prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('u1','Fixture','fixture@example.invalid',1,'2026','2026')"
    ),
  ]);
  // Both requests validate against the clean order; the second keeps its
  // stale result while the first is inserted and completed.
  const stale = await validateReturnItems(db, 'o', [{ orderItemId: 'i1', qty: 2 }]);
  expect(stale.ok).toBe(true);
  const first = await validateReturnItems(db, 'o', [{ orderItemId: 'i1', qty: 2 }]);
  expect(first.ok).toBe(true);
  if (first.ok) {
    const inserted = await insertReturnRequest(db, 'o', 'u1', 'first', first.items);
    expect(inserted.ok).toBe(true);
    if (inserted.ok)
      await db
        .prepare("UPDATE returns SET status='refunded' WHERE id=?")
        .bind(inserted.returnId)
        .run();
  }
  if (stale.ok) {
    const delayed = await insertReturnRequest(db, 'o', 'u1', 'delayed', stale.items);
    expect(delayed.ok).toBe(false);
  }
  expect(
    (
      await db
        .prepare(
          'SELECT COALESCE(SUM(qty),0) AS q FROM return_items ri JOIN returns r ON r.id=ri.return_id'
        )
        .first<{ q: number }>()
    )?.q
  ).toBe(2);
});
it('a failed return retry defaults to its own share, not the balance claimed by a requested return', () => {
  // One line of 10 units at $1 each, no shipping/discount/tax. Return A
  // (1 unit) was refunded then failed; return B (9 units) is only requested.
  const lines = [{ orderItemId: 'a', qty: 10, unitPriceCents: 100 }];
  const returns = [
    { id: 'ra', status: 'refund_failed', items: [{ order_item_id: 'a', qty: 1 }] },
    { id: 'rb', status: 'requested', items: [{ order_item_id: 'a', qty: 9 }] },
  ];
  const beforeA = refundedQtyBefore(returns, 'ra');
  expect(beforeA).toEqual({});
  expect(
    calculatedReturnRefundCents({
      lines,
      items: [{ orderItemId: 'a', qty: 1 }],
      returnedBeforeQty: beforeA,
      discountCents: 0,
      taxCents: 0,
      totalCents: 1000,
      shippingCents: 0,
      refundableCents: 1000,
    })
  ).toBe(100);
  // Once B is actually refunded, A becomes final and takes what remains.
  const settled = [
    returns[0]!,
    { id: 'rb', status: 'refunded', items: [{ order_item_id: 'a', qty: 9 }] },
  ];
  expect(
    calculatedReturnRefundCents({
      lines,
      items: [{ orderItemId: 'a', qty: 1 }],
      returnedBeforeQty: refundedQtyBefore(settled, 'ra'),
      discountCents: 0,
      taxCents: 0,
      totalCents: 1000,
      shippingCents: 0,
      refundableCents: 100,
    })
  ).toBe(100);
});
it('calculated refunds for a fully returned order sum to total minus shipping', () => {
  const lines = [
    { orderItemId: 'a', qty: 2, unitPriceCents: 333 },
    { orderItemId: 'b', qty: 1, unitPriceCents: 334 },
  ];
  const money = { discountCents: 100, taxCents: 55, totalCents: 1454, shippingCents: 499 };
  const first = calculatedReturnRefundCents({
    lines,
    items: [{ orderItemId: 'a', qty: 1 }],
    returnedBeforeQty: {},
    ...money,
    refundableCents: 1454,
  });
  expect(first).toBe(318);
  const last = calculatedReturnRefundCents({
    lines,
    items: [
      { orderItemId: 'a', qty: 1 },
      { orderItemId: 'b', qty: 1 },
    ],
    returnedBeforeQty: { a: 1 },
    ...money,
    refundableCents: 1454 - first,
  });
  expect(first + last).toBe(1454 - 499);
});
it('calculated refund edge cases: itemless excludes shipping, zero and unknown are zero, caps apply', () => {
  const base = {
    lines: [{ orderItemId: 'a', qty: 1, unitPriceCents: 1000 }],
    returnedBeforeQty: {},
    discountCents: 0,
    taxCents: 0,
    totalCents: 1200,
    shippingCents: 200,
    refundableCents: 1200,
  };
  expect(calculatedReturnRefundCents({ ...base, items: [] })).toBe(1000);
  expect(
    calculatedReturnRefundCents({
      ...base,
      lines: [{ orderItemId: 'a', qty: 1, unitPriceCents: 0 }],
      items: [{ orderItemId: 'a', qty: 1 }],
      totalCents: 0,
      refundableCents: 0,
    })
  ).toBe(0);
  expect(calculatedReturnRefundCents({ ...base, items: [{ orderItemId: 'zzz', qty: 1 }] })).toBe(0);
  expect(
    calculatedReturnRefundCents({
      ...base,
      lines: [
        { orderItemId: 'a', qty: 1, unitPriceCents: 1000 },
        { orderItemId: 'b', qty: 1, unitPriceCents: 500 },
      ],
      items: [{ orderItemId: 'a', qty: 1 }],
      refundableCents: 400,
    })
  ).toBe(400);
});

it('a collection edit never changes its slug, so no published collection URL can go stale', async () => {
  await db
    .prepare(
      "INSERT INTO collections(id,slug,title,kind,created_at) VALUES('c','tees','Tees','manual','2026-01-01')"
    )
    .run();

  const result = await runAdminAction(db, env, owner, 'collection.update', {
    collectionId: 'c',
    slug: 'renamed',
    title: 'Renamed tees',
    description: '',
    featuredRank: null,
  });

  expect(result.ok).toBe(true);
  const row = await db
    .prepare("SELECT slug,title FROM collections WHERE id='c'")
    .first<{ slug: string; title: string }>();
  expect(row).toEqual({ slug: 'tees', title: 'Renamed tees' });
});

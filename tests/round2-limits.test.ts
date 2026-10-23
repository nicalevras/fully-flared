import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { getSettings, setSetting } from '../web/src/server/settings';
import { ensureCart, setCartLine, priceCartLines } from '../web/src/server/cart';
import { createPendingOrder, cancelOrderById, quoteOrder } from '../web/src/server/checkout';
import { requestRefund, reconcileRefundOperations } from '../web/src/server/refunds';
import { adjustStock } from '../web/src/server/inventory';
import { readFileSync } from 'node:fs';
import { LIMIT_KEYS, LIMIT_DEFINITIONS } from '../web/src/schemas/limits';

let db: D1Database, dispose: () => Promise<void>;
beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 2000 });
});
afterAll(async () => dispose());
const bounds = [
  ['checkout_email_cap', 1, 100, 5],
  ['checkout_account_cap', 1, 100, 5],
  ['checkout_ip_cap', 1, 1000, 10],
  ['cart_max_qty', 1, 999, 99],
  ['cart_max_lines', 1, 100, 50],
  ['order_max_units', 1, 10000, 500],
  ['checkout_session_minutes', 32, 1440, 32],
  ['refund_retry_cap', 1, 20, 5],
  ['refund_stuck_minutes', 1, 10080, 60],
] as const;
it('enforces every limit bound in Zod and direct SQL, including invalid numeric encodings', async () => {
  for (const [key, min, max, fallback] of bounds) {
    for (const value of [String(min - 1), String(max + 1), '1.5', '1e2', '', '01']) {
      await expect(setSetting(db, key, value)).rejects.toThrow();
      await expect(
        db.prepare('UPDATE settings SET value=? WHERE key=?').bind(value, key).run()
      ).rejects.toThrow(/setting|limit|Session duration/i);
      await expect(
        db
          .prepare(
            'INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
          )
          .bind(key, value, new Date().toISOString())
          .run()
      ).rejects.toThrow(/setting|limit|Session duration/i);
    }
    await setSetting(db, key, String(min));
    await setSetting(db, key, String(max));
    await setSetting(db, key, String(fallback));
  }
});
it('uses nondefault limits and retains the legacy hold buffer around the configured Session', async () => {
  await setSetting(db, 'cart_max_qty', '150');
  const cart = await ensureCart(db, null);
  expect((await setCartLine(db, cart.creds, 'TEE-1', 120)).lines[0]?.qty).toBe(120);
  await setSetting(db, 'cart_max_qty', '10');
  expect((await setCartLine(db, cart.creds, 'TEE-1', 119)).lines[0]?.qty).toBe(119);
  await expect(setCartLine(db, cart.creds, 'TEE-1', 121)).rejects.toThrow(/limit|quantity/i);
  await setSetting(db, 'cart_max_qty', '99');
  await setSetting(db, 'checkout_email_cap', '1');
  await setSetting(db, 'checkout_session_minutes', '60');
  const input = {
    email: 'cap@example.test',
    shippingCountry: 'US',
    shippingRateId: 'test-rate',
    lines: [{ sku: 'TEE-1', qty: 1 }],
  };
  const order = await createPendingOrder(db, input);
  await expect(createPendingOrder(db, input)).rejects.toThrow(/Too many open checkouts/);
  const hold = await db
    .prepare('SELECT expires_at,created_at FROM reservations WHERE order_id=?')
    .bind(order.orderId)
    .first<{ expires_at: string; created_at: string }>();
  expect(Date.parse(hold!.expires_at) - Date.parse(hold!.created_at)).toBeGreaterThan(
    70 * 60000 - 1000
  );
  expect(Date.parse(hold!.expires_at) - Date.parse(hold!.created_at)).toBeLessThanOrEqual(
    70 * 60000
  );
  await cancelOrderById(db, order.orderId);
  await setSetting(db, 'checkout_email_cap', '5');
  await setSetting(db, 'checkout_session_minutes', '32');
});
it('configured refund retry caps and stuck thresholds affect reconciliation', async () => {
  await db
    .prepare(
      "INSERT INTO orders(id,number,status,payment_status,customer_email,stripe_payment_intent_id,subtotal_cents,total_cents,created_at,updated_at) VALUES('policy-refund','POLICY','paid','paid','policy@example.test','pi_policy',100,100,?,?)"
    )
    .bind(new Date().toISOString(), new Date().toISOString())
    .run();
  await setSetting(db, 'refund_retry_cap', '1');
  let calls = 0;
  const provider = {
    async createCheckout() {
      return { sessionId: '', url: '' };
    },
    async verifyWebhook() {
      throw new Error('not used');
    },
    async refund() {
      calls++;
      return { id: 're_policy', status: 'pending' };
    },
  };
  const input = {
    orderId: 'policy-refund',
    amountCents: 100,
    requestId: 'policy-op',
    purpose: 'staff' as const,
  };
  await requestRefund(db, provider, input);
  await db.prepare("UPDATE refunds SET retry_after=NULL WHERE id='policy-op'").run();
  await requestRefund(db, provider, input);
  expect(calls).toBe(1);
  await expect(
    db.prepare("UPDATE refunds SET attempts=2 WHERE id='policy-op'").run()
  ).rejects.toThrow(/retry limit/);
  await setSetting(db, 'refund_retry_cap', '5');
  await setSetting(db, 'refund_stuck_minutes', '2');
  await setSetting(db, 'operational_alert_email', 'ops@example.test');
  await db
    .prepare("UPDATE refunds SET created_at=?,retry_after=? WHERE id='policy-op'")
    .bind(
      new Date(Date.now() - 3 * 60000).toISOString(),
      new Date(Date.now() + 86400000).toISOString()
    )
    .run();
  await reconcileRefundOperations(db, provider);
  expect(
    await db
      .prepare("SELECT id FROM outbox WHERE id='refund-stuck-policy-op-ops@example.test'")
      .first()
  ).not.toBeNull();
});
it('missing limit rows return defaults and leave SQL guards effective', async () => {
  for (const [key] of bounds) await db.prepare('DELETE FROM settings WHERE key=?').bind(key).run();
  expect((await getSettings(db)).limits).toEqual(
    Object.fromEntries(bounds.map(([key, , , fallback]) => [key, fallback]))
  );
  const cart = await ensureCart(db, null);
  await db
    .prepare('INSERT INTO cart_items VALUES(?,?,?,?,?)')
    .bind('fallback-line', cart.creds.id, 'TEE-1', 99, 1)
    .run();
  await expect(
    db.prepare('UPDATE cart_items SET qty=100 WHERE id=?').bind('fallback-line').run()
  ).rejects.toThrow(/limit|quantity/i);
  await expect(setCartLine(db, cart.creds, 'TEE-1', 1)).resolves.toMatchObject({
    lines: [{ qty: 1 }],
  });
  for (let i = 0; i < 5; i++)
    await db
      .prepare(
        'INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,created_at,updated_at) VALUES(?,?,?,1,1,?,?)'
      )
      .bind(
        `fallback-${i}`,
        `FALLBACK-${i}`,
        'fallback@example.test',
        new Date().toISOString(),
        new Date().toISOString()
      )
      .run();
  await expect(
    db
      .prepare(
        "INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,created_at,updated_at) VALUES('fallback-6','FALLBACK-6','fallback@example.test',1,1,?,?)"
      )
      .bind(new Date().toISOString(), new Date().toISOString())
      .run()
  ).rejects.toThrow(/Too many open checkouts/);
});
it('baseline carries the settings bounds/defaults in its guards and seeds', () => {
  const sql = readFileSync('web/migrations/0000_initial.sql', 'utf8');
  for (const key of LIMIT_KEYS) {
    if (key === 'checkout_session_minutes') {
      const forward = readFileSync('web/migrations/0013_authorized_checkout.sql', 'utf8');
      expect(forward).toContain("NEW.key='checkout_session_minutes'");
      expect(forward).toContain('AS INTEGER)<32');
      expect(forward).toContain('AS INTEGER)>1440');
      continue;
    }
    const spec = LIMIT_DEFINITIONS[key];
    expect(sql).toContain(`WHEN '${key}' THEN ${spec.min}`);
    expect(sql).toContain(`WHEN '${key}' THEN ${spec.max}`);
    expect(sql).toContain(`('${key}','${spec.default}'`);
  }
});
it('prices and orders the configured 100-line boundary without exceeding D1 parameter limits', async () => {
  await setSetting(db, 'cart_max_lines', '100');
  const now = new Date().toISOString();
  const lines = Array.from({ length: 100 }, (_, i) => ({ sku: `BOUNDARY-${i}`, qty: 1 }));
  // Reuse the product, but give every checkout line its own active variant and stock.
  for (const line of lines)
    await db.batch([
      db
        .prepare(
          "INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) VALUES(?,'p1',?,'Boundary',100,'active',?)"
        )
        .bind(line.sku, line.sku, now),
      db
        .prepare('INSERT INTO stock(sku,on_hand,reserved,updated_at) VALUES(?,1,0,?)')
        .bind(line.sku, now),
      db
        .prepare(
          "INSERT INTO stock_ledger(id,sku,delta_on_hand,delta_reserved,reason,created_at) VALUES(?,?,1,0,'restock',?)"
        )
        .bind(line.sku, line.sku, now),
    ]);
  expect(await priceCartLines(db, lines)).toHaveLength(100);
  const input = {
    email: 'boundary@example.test',
    shippingCountry: 'US',
    shippingRateId: 'test-rate',
    lines,
  };
  expect((await quoteOrder(db, input)).subtotalCents).toBe(10000);
  const order = await createPendingOrder(db, input);
  expect(
    await db
      .prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id=?')
      .bind(order.orderId)
      .first()
  ).toEqual({ n: 100 });
  await cancelOrderById(db, order.orderId);
  await adjustStock(db, 'BOUNDARY-99', -1, 'correction');
  const before = await db.prepare('SELECT COUNT(*) AS n FROM orders').first();
  await expect(createPendingOrder(db, input)).rejects.toThrow(/Insufficient stock/);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM orders').first()).toEqual(before);
  expect(await db.prepare("SELECT reserved FROM stock WHERE sku='BOUNDARY-0'").first()).toEqual({
    reserved: 0,
  });
  await setSetting(db, 'cart_max_lines', '50');
});

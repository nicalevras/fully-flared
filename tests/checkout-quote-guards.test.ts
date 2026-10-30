import { beforeEach, afterEach, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { createPendingOrder, quoteOrder } from '../web/src/server/checkout';
import { getSettings } from '../web/src/server/settings';
import { heldOrder, pendingIntent } from './helpers/pending-intent';

let db: D1Database, dispose: () => Promise<void>;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 100000, priceCents: 100 });
  const now = new Date().toISOString();
  for (let i = 2; i <= 50; i++)
    await db.batch([
      db
        .prepare(
          "INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) VALUES(?,'p1',?,'B',100,'active',?)"
        )
        .bind(`v${i}`, `SKU-${i}`, now),
      db
        .prepare('INSERT INTO stock(sku,on_hand,reserved,updated_at) VALUES(?,100000,0,?)')
        .bind(`SKU-${i}`, now),
    ]);
});
afterEach(async () => {
  await dispose();
});

function counting(target: D1Database) {
  let prepares = 0;
  const proxy = new Proxy(target, {
    get(t, key) {
      if (key === 'prepare')
        return (sql: string) => {
          prepares++;
          return t.prepare(sql);
        };
      const v = Reflect.get(t, key);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { proxy, count: () => prepares };
}

const input = (n: number) => ({
  email: 'guard@example.invalid',
  lines: Array.from({ length: n }, (_, i) => ({
    sku: i === 0 ? 'TEE-1' : `SKU-${i + 1}`,
    qty: 1,
  })),
  shippingRateId: 'test-rate',
  shippingCountry: 'US',
});

it('initiation statement count is basket-size independent and within target', async () => {
  const one = counting(db);
  await createPendingOrder(one.proxy, input(1), pendingIntent());
  const fifty = counting(db);
  await createPendingOrder(fifty.proxy, input(50), pendingIntent());
  expect(fifty.count()).toBeLessThanOrEqual(25);
  expect(fifty.count() - one.count()).toBeLessThanOrEqual(2);
  expect(
    (await db.prepare('SELECT COUNT(*) AS n FROM reservations').first<{ n: number }>())?.n
  ).toBe(0);
  expect(
    (await db.prepare('SELECT COUNT(*) AS n FROM order_items').first<{ n: number }>())?.n
  ).toBe(51);
});

it('a new order holds no stock or coupon and its intent waits for authorization', async () => {
  await db
    .prepare(
      "INSERT INTO discounts(id,code,type,value,usage_per_customer,created_at) VALUES('coupon','SAVE','percentage',10,1,?)"
    )
    .bind(new Date().toISOString())
    .run();
  const intent = pendingIntent();
  const created = await createPendingOrder(db, { ...input(2), discountCode: 'SAVE' }, intent);
  expect(created.discountCents).toBeGreaterThan(0);
  const count = async (table: string) =>
    (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
  expect(await count('reservations')).toBe(0);
  expect(await count('discount_usage')).toBe(0);
  expect(await db.prepare("SELECT usage_count FROM discounts WHERE id='coupon'").first()).toEqual({
    usage_count: 0,
  });
  expect(await db.prepare('SELECT SUM(reserved) AS n FROM stock').first()).toEqual({ n: 0 });
  expect(
    await db
      .prepare(
        'SELECT state,allocation_id,payment_next_at,session_expires_at FROM checkout_intents WHERE id=?'
      )
      .bind(intent.id)
      .first()
  ).toEqual({
    state: 'reserved',
    allocation_id: null,
    payment_next_at: intent.sessionExpiresAt,
    session_expires_at: intent.sessionExpiresAt,
  });
});

it('configuration changes advance the revision; stock movement does not', async () => {
  const before = (await getSettings(db)).configRevision;
  await db.prepare("UPDATE stock SET reserved = reserved + 1 WHERE sku='TEE-1'").run();
  expect((await getSettings(db)).configRevision).toBe(before);
  await db.prepare("UPDATE variants SET price_cents = 101 WHERE sku='TEE-1'").run();
  const afterPrice = (await getSettings(db)).configRevision;
  expect(afterPrice).toBeGreaterThan(before);
  await db.prepare("UPDATE settings SET value='Store' WHERE key='store_name'").run();
  expect((await getSettings(db)).configRevision).toBe(afterPrice);
  const { setSetting } = await import('../web/src/server/settings');
  await setSetting(db, 'currency', 'EUR');
  expect((await getSettings(db)).configRevision).toBeGreaterThan(afterPrice);
});

it('a quote whose revision changed before commit is rejected, never repriced silently', async () => {
  const settings = await getSettings(db);
  const quote = await quoteOrder(db, input(1), settings);
  expect(quote.configRevision).toBe(settings.configRevision);
  await db.prepare("UPDATE variants SET price_cents = 555 WHERE sku='TEE-1'").run();
  await expect(createPendingOrder(db, input(1), pendingIntent(), settings)).rejects.toMatchObject({
    code: 'STALE_QUOTE',
    status: 409,
  });
  expect((await db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>())?.n).toBe(0);
  // A fresh submission at the new revision succeeds at the new price.
  const fresh = await heldOrder(db, input(1));
  expect(fresh.totalCents).toBe(555);
});

it('a discounted checkout does not trip its own revision guard via usage_count', async () => {
  await db
    .prepare(
      "INSERT INTO discounts (id, code, type, value, status, usage_per_customer, created_at) VALUES ('d1', 'SAVE10', 'percentage', 10, 'active', 1, ?)"
    )
    .bind(new Date().toISOString())
    .run();
  const settings = await getSettings(db);
  const created = await createPendingOrder(
    db,
    { ...input(1), discountCode: 'SAVE10' },
    pendingIntent(),
    settings
  );
  expect(created.discountCents).toBe(10);
  // Claiming the coupon (usage_count) must not advance the revision:
  // capacity is guarded inside the batch, it is not configuration.
  const after = await getSettings(db);
  await db.prepare("UPDATE discounts SET usage_count = usage_count + 1 WHERE id='d1'").run();
  expect((await getSettings(db)).configRevision).toBe(after.configRevision);
});

it('stock-only movement between quote and submit does not invalidate the quote', async () => {
  const settings = await getSettings(db);
  await db.prepare("UPDATE stock SET reserved = reserved + 5 WHERE sku='TEE-1'").run();
  const created = await createPendingOrder(db, input(1), pendingIntent(), settings);
  expect(created.totalCents).toBe(100);
});

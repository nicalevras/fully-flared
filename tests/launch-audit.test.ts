import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { env } from './helpers/cloudflare-workers-stub';
import { Route } from '../web/src/routes/api/reports';
import { currencyCodeSchema } from '../web/src/schemas/settings';
import { pruneRetention } from '../web/src/server/operations';
import { restockOrderStatements } from '../web/src/server/inventory';
import { paidRevenueByCurrency, monetaryReportQueries } from '../web/src/server/reports';
import { insertReturnRequest } from '../web/src/server/returns';

const actor = vi.hoisted(() => ({ role: 'owner' }));
vi.mock('../web/src/server/session', async (original) => ({
  ...(await original<typeof import('../web/src/server/session')>()),
  requireStaff: async () => ({ id: 'staff', role: actor.role }),
}));
let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  env.DB = db;
  actor.role = 'owner';
});
afterEach(async () => {
  delete env.DB;
  await dispose();
});
async function order(id: string, payment = 'paid', currency = 'USD', status = 'paid') {
  await db
    .prepare(
      `INSERT INTO orders(id,number,customer_email,currency,subtotal_cents,total_cents,status,payment_status,created_at,updated_at) VALUES(?,?, 'fixture@example.invalid',?,1000,1000,?,?,'2024-01-01','2024-01-01')`
    )
    .bind(id, id, currency, status, payment)
    .run();
}
async function report(type: string, format = 'json') {
  const handler = Route.options.server!.handlers!.GET!;
  return (handler as (ctx: { request: Request }) => Promise<Response>)({
    request: new Request(`http://localhost/api/reports?type=${type}&format=${format}`),
  });
}
it('accepts only the seven supported two-decimal currencies', () => {
  for (const code of ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF'])
    expect(currencyCodeSchema.safeParse(code).success).toBe(true);
  for (const code of ['JPY', 'KWD', 'XYZ', 'usd'])
    expect(currencyCodeSchema.safeParse(code).success).toBe(false);
});
it('denies customer, order and sales exports before querying data, in CSV and JSON', async () => {
  for (const role of ['warehouse', 'support']) {
    actor.role = role;
    const prepare = vi.spyOn(db, 'prepare');
    for (const format of ['json', 'csv']) {
      expect((await report('customers', format)).status).toBe(403);
      expect((await report('orders', format)).status).toBe(403);
      expect((await report('sales', format)).status).toBe(403);
    }
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    expect((await report('inventory')).status).toBe(200);
  }
  for (const role of ['manager', 'owner']) {
    actor.role = role;
    for (const format of ['json', 'csv'])
      expect((await report('customers', format)).status).toBe(200);
  }
});
it('retains old committed sales for restocking, but prunes old released holds', async () => {
  await seedProduct(db, { onHand: 9 });
  await order('old');
  await db
    .prepare(
      `INSERT INTO reservations(id,cart_id,order_id,sku,qty,status,expires_at,created_at) VALUES('sold','cart','old','TEE-1',1,'committed','2024','2024'),('released','cart','old','TEE-1',1,'released','2024','2024')`
    )
    .run();
  await pruneRetention(db);
  expect((await db.prepare('SELECT id FROM reservations ORDER BY id').all()).results).toEqual([
    { id: 'sold' },
  ]);
  await db.batch(restockOrderStatements(db, 'old', { sql: '1=1', values: [] }));
  expect((await db.prepare("SELECT on_hand FROM stock WHERE sku='TEE-1'").first())?.on_hand).toBe(
    10
  );
});
it('retention deletes in bounded pages of 1000 per run', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({ id: `w${i}` }));
  await db
    .prepare(
      `INSERT INTO webhook_inbox(id,provider,event_id,type,payload_json,received_at,status,processed_at) SELECT json_extract(value,'$.id'),'stripe',json_extract(value,'$.id'),'test','{}','2020-01-01','processed','2020-01-02' FROM json_each(?)`
    )
    .bind(JSON.stringify(rows))
    .run();
  const first = await pruneRetention(db);
  expect(first.webhookInbox).toBe(1000);
  const second = await pruneRetention(db);
  expect(second.webhookInbox).toBe(1);
});
it('prunes expired converted carts but keeps unexpired ones', async () => {
  await db.batch([
    db.prepare(
      "INSERT INTO carts(id,token_hash,status,expires_at,created_at,updated_at) VALUES('conv-old','h1','converted','2020-01-01','2020','2020')"
    ),
    db.prepare(
      "INSERT INTO carts(id,token_hash,status,expires_at,created_at,updated_at) VALUES('conv-new','h2','converted','2999-01-01','2020','2020')"
    ),
  ]);
  const result = await pruneRetention(db);
  expect(result.carts).toBe(1);
  expect((await db.prepare('SELECT id FROM carts').all()).results).toEqual([{ id: 'conv-new' }]);
});
it('uses original gross amounts across currencies and refund states, excluding unpaid and recovery payments', async () => {
  for (const [id, payment, currency, status] of [
    ['paid', 'paid', 'USD', 'paid'],
    ['partial', 'partially_refunded', 'USD', 'partially_refunded'],
    ['refunded', 'refunded', 'EUR', 'refunded'],
    ['unpaid', 'unpaid', 'USD', 'pending_payment'],
    ['failed', 'failed', 'USD', 'canceled'],
    ['recovery', 'paid', 'USD', 'canceled'],
  ]) {
    await order(id, payment, currency, status);
    await db
      .prepare(
        "INSERT INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES(?,?,'TEE-1','Tee',1,1000)"
      )
      .bind(id, id)
      .run();
  }
  await db
    .prepare(
      "INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,status,created_at) VALUES('late-recovery','late-recovery','recovery',1000,'late_payment','failed','2026')"
    )
    .run();
  expect(await paidRevenueByCurrency(db)).toEqual([
    { currency: 'EUR', revenue: 1000, orders: 1 },
    { currency: 'USD', revenue: 2000, orders: 2 },
  ]);
  for (const [query, key] of [
    [monetaryReportQueries.products, 'revenue_cents'],
    [monetaryReportQueries.customers, 'spent_cents'],
  ]) {
    const rows = (await db.prepare(query).all()).results;
    expect(rows.map((r) => [r.currency, r[key]]).sort()).toEqual([
      ['EUR', 1000],
      ['USD', 2000],
    ]);
  }
  const sales = (await (await report('sales')).json()) as {
    rows: Array<{ currency: string; total_cents: number }>;
  };
  expect(sales.rows.map((r) => [r.currency, r.total_cents]).sort()).toEqual([
    ['EUR', 1000],
    ['USD', 2000],
  ]);
  // A failed recovery followed by successful fulfillment is a real sale.
  await db
    .prepare(
      "INSERT INTO reservations(id,cart_id,order_id,sku,qty,status,expires_at,created_at) VALUES('recovered','cart','recovery','TEE-1',1,'committed','2026','2026')"
    )
    .run();
  expect(await paidRevenueByCurrency(db)).toEqual([
    { currency: 'EUR', revenue: 1000, orders: 1 },
    { currency: 'USD', revenue: 3000, orders: 3 },
  ]);
});
it('allows only one active return under concurrent inserts and permits a request after rejection or refund', async () => {
  await order('returns');
  const insert = (id: string) =>
    db
      .prepare(
        "INSERT INTO returns(id,order_id,status,created_at) VALUES(?,'returns','requested','2026')"
      )
      .bind(id)
      .run();
  const results = await Promise.allSettled([insert('a'), insert('b')]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  await db.prepare("UPDATE returns SET status='rejected'").run();
  await insert('c');
  await db.prepare("UPDATE returns SET status='approved' WHERE id='c'").run();
  await expect(insert('d')).rejects.toThrow(/UNIQUE/);
  await db.prepare("UPDATE returns SET status='refunded' WHERE id='c'").run();
  await insert('e');
});
it('returns the friendly conflict for simultaneous app requests and rethrows unrelated database failures', async () => {
  await order('app-returns');
  await db
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('customer','Fixture','returns@example.invalid',1,0,0)"
    )
    .run();
  const results = await Promise.all([
    insertReturnRequest(db, 'app-returns', 'customer', ''),
    insertReturnRequest(db, 'app-returns', 'customer', ''),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)).toEqual({
    ok: false,
    error: 'A return is already in progress for this order',
  });
  await expect(insertReturnRequest(db, 'missing-order', 'customer', '')).rejects.toThrow(
    /FOREIGN KEY/
  );
});
it('baseline refuses a second active return for the same order', async () => {
  await db
    .prepare(
      "INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,created_at,updated_at) VALUES('o','O','fixture@example.invalid',100,100,'2026','2026')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO returns(id,order_id,status,created_at) VALUES('a','o','requested','2026')"
    )
    .run();
  await expect(
    db
      .prepare(
        "INSERT INTO returns(id,order_id,status,created_at) VALUES('b','o','approved','2026')"
      )
      .run()
  ).rejects.toThrow(/UNIQUE/);
  expect((await db.prepare('SELECT COUNT(*) n FROM returns').first())?.n).toBe(1);
});

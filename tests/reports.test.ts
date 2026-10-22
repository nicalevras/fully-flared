import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { env } from './helpers/cloudflare-workers-stub';
import { createTestDb } from './helpers/d1';
import { Route, exportReport } from '../web/src/routes/api/reports';
import { parseCsv } from '../web/src/server/csv';

const actor = vi.hoisted(() => ({ role: 'owner' }));
vi.mock('../web/src/server/session', async (original) => ({
  ...(await original<typeof import('../web/src/server/session')>()),
  requireStaff: async () => ({ id: 'staff', role: actor.role }),
}));
let db: D1Database, dispose: () => Promise<void>;
beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  env.DB = db;
});
afterAll(async () => {
  delete env.DB;
  await dispose();
});
async function get(role: string, query: string) {
  actor.role = role;
  const handlers = Route.options.server!.handlers;
  if (typeof handlers === 'function') throw new Error('Expected direct route handlers');
  const handler = handlers!.GET;
  if (typeof handler !== 'function') throw new Error('Expected GET handler');
  return handler({
    request: new Request(`http://localhost:8799/api/reports?${query}`),
  } as never) as Promise<Response>;
}
it('gates orders and sales exports behind customer export permission', async () => {
  for (const role of ['warehouse', 'support']) {
    expect((await get(role, 'type=orders&format=csv')).status).toBe(403);
    expect((await get(role, 'type=sales')).status).toBe(403);
  }
  expect((await get('owner', 'type=orders&format=csv')).status).toBe(200);
  expect((await get('warehouse', 'type=inventory')).status).toBe(200);
});
it('rejects unknown report types instead of falling back to sales', async () => {
  expect((await get('owner', 'type=bogus')).status).toBe(400);
  expect((await get('owner', '')).status).toBe(200);
});

async function seedOrders(
  count: number,
  opts: {
    prefix: string;
    day?: string;
    email?: string;
    emailPrefix?: string;
    cents?: number;
    currency?: string;
  }
) {
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${opts.prefix}-${String(i).padStart(4, '0')}`;
    stmts.push(
      db
        .prepare(
          "INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,currency,status,payment_status,created_at,updated_at) VALUES(?,?,?,?,?,?,'paid','paid',?,?)"
        )
        .bind(
          id,
          id,
          opts.email ??
            (opts.emailPrefix
              ? `${opts.emailPrefix}${i}@example.invalid`
              : 'fixture@example.invalid'),
          opts.cents ?? 100,
          opts.cents ?? 100,
          opts.currency ?? 'USD',
          opts.day ?? '2026-01-01T00:00:00.000Z',
          opts.day ?? '2026-01-01T00:00:00.000Z'
        )
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
}

it('orders export is complete over 501 tied orders, with totals per currency', async () => {
  await seedOrders(300, { prefix: 'usd', cents: 100, currency: 'USD' });
  await seedOrders(201, { prefix: 'eur', cents: 200, currency: 'EUR' });
  const csv = await get('owner', 'type=orders&format=csv');
  expect(csv.status).toBe(200);
  const parsed = parseCsv(await csv.text());
  expect(parsed).toHaveLength(502);
  const json = (await (await get('owner', 'type=orders')).json()) as {
    type: string;
    rows: Array<{ number: string; total_cents: number; currency: string }>;
  };
  expect(json.type).toBe('orders');
  expect(json.rows).toHaveLength(501);
  expect(json.rows[0]?.number).toBe('usd-0299');
  expect(json.rows.at(-1)?.number).toBe('eur-0000');
  const sum = (c: string) =>
    json.rows.filter((r) => r.currency === c).reduce((s, r) => s + r.total_cents, 0);
  expect(sum('USD')).toBe(30_000);
  expect(sum('EUR')).toBe(40_200);
}, 120_000);

it('sales, products and customers exports are not silently capped at 90/100 rows', async () => {
  // 60 days x 2 currencies of sales groups (120 rows, over the old 90 cap).
  for (let d = 0; d < 60; d++) {
    const day = new Date(Date.UTC(2025, 0, 1 + d)).toISOString();
    await seedOrders(1, { prefix: `sd${d}u`, day, cents: 100, currency: 'USD' });
    await seedOrders(1, { prefix: `sd${d}e`, day, cents: 100, currency: 'EUR' });
  }
  const sales = (await (await get('owner', 'type=sales')).json()) as { rows: unknown[] };
  expect(sales.rows.length).toBeGreaterThan(90);
  // 120 distinct customers and products.
  await seedOrders(120, { prefix: 'cust', emailPrefix: 'cust' });
  const customers = (await (await get('owner', 'type=customers')).json()) as { rows: unknown[] };
  expect(customers.rows.length).toBeGreaterThan(100);
  const itemStmts: D1PreparedStatement[] = [];
  for (let i = 0; i < 120; i++)
    itemStmts.push(
      db
        .prepare(
          "INSERT INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES(?,?,?, 'Fixture',1,100)"
        )
        .bind(`pi-${i}`, `cust-${String(i).padStart(4, '0')}`, `SKU-${String(i).padStart(3, '0')}`)
    );
  for (let i = 0; i < itemStmts.length; i += 50) await db.batch(itemStmts.slice(i, i + 50));
  const products = (await (await get('owner', 'type=products')).json()) as {
    rows: Array<{ sku: string; units: number }>;
  };
  expect(products.rows.length).toBeGreaterThan(100);
  expect(products.rows.find((r) => r.sku === 'SKU-119')?.units).toBe(1);
}, 120_000);

it('a concurrent same-timestamp insert and an update land wholly in one statement state', async () => {
  let statements = 0;
  let injected = false;
  const proxied = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          statements++;
          const stmt = target.prepare(sql);
          return {
            bind: (...values: unknown[]) => ({
              all: async () => {
                if (!injected) {
                  injected = true;
                  await target
                    .prepare(
                      "INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,currency,status,payment_status,created_at,updated_at) VALUES('aaa-new','aaa-new','fixture@example.invalid',100,100,'USD','paid','paid','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')"
                    )
                    .run();
                  await target
                    .prepare("UPDATE orders SET total_cents=999 WHERE id='usd-0000'")
                    .run();
                }
                return stmt.bind(...values).all();
              },
            }),
          };
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const response = await exportReport(proxied as D1Database, 'orders', 'json');
  expect(statements).toBe(1);
  const body = (await response.json()) as {
    rows: Array<{ number: string; total_cents: number }>;
  };
  expect(body.rows.some((r) => r.number === 'aaa-new')).toBe(true);
  expect(body.rows.find((r) => r.number === 'usd-0000')?.total_cents).toBe(999);
}, 120_000);

it('a database failure returns a generic JSON error, never an attachment or raw error', async () => {
  const failing = {
    prepare: () => ({
      bind: () => ({
        all: async () => {
          throw new Error('D1_ERROR: internal detail that must not leak');
        },
      }),
    }),
  } as unknown as D1Database;
  const response = await exportReport(failing, 'orders', 'csv');
  expect(response.status).toBe(500);
  expect(response.headers.get('Content-Disposition')).toBeNull();
  expect(response.headers.get('Content-Type')).toContain('application/json');
  const body = (await response.json()) as { error: string };
  expect(body.error).toBe('Report export failed');
  expect(JSON.stringify(body)).not.toContain('D1_ERROR');
});

it('JSON byte overflow is rejected with 413, wrapper counted', async () => {
  const response = await exportReport(db, 'orders', 'json', {
    maxRows: 25_000,
    maxBytes: 100,
  });
  expect(response.status).toBe(413);
  expect(response.headers.get('Content-Disposition')).toBeNull();
  expect(response.headers.get('Content-Type')).toContain('application/json');
});

it('ceilings fail explicitly with 413 and no attachment, including long field values', async () => {
  const longEmail = `${'a'.repeat(200)}@example.invalid`;
  await seedOrders(20, { prefix: 'long', email: longEmail, cents: 100 });
  const wide = await exportReport(db, 'orders', 'json');
  expect(wide.status).toBe(200);
  const wideBody = (await wide.json()) as { rows: Array<{ customer_email: string }> };
  expect(wideBody.rows.some((r) => r.customer_email === longEmail)).toBe(true);
  const byRows = await exportReport(db, 'orders', 'csv', {
    maxRows: 10,
    maxBytes: 16 * 1024 * 1024,
  });
  expect(byRows.status).toBe(413);
  expect(byRows.headers.get('Content-Disposition')).toBeNull();
  const byBytes = await exportReport(db, 'orders', 'csv', { maxRows: 25_000, maxBytes: 100 });
  expect(byBytes.status).toBe(413);
  expect(byBytes.headers.get('Content-Disposition')).toBeNull();
}, 120_000);

it('a 25,000-row export with long field values completes within the default ceilings', async () => {
  // Fresh database so the export holds exactly 25,000 orders.
  await dispose();
  ({ db, dispose } = await createTestDb());
  env.DB = db;
  const longEmail = `${'b'.repeat(200)}@example.invalid`;
  await db
    .prepare(
      `INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,currency,status,payment_status,created_at,updated_at)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 25000)
       SELECT 'big-' || printf('%05d', n), 'big-' || printf('%05d', n), ?, 100, 100, 'USD', 'paid', 'paid', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z' FROM seq`
    )
    .bind(longEmail)
    .run();
  const total = (await db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>())?.n;
  const csv = await exportReport(db, 'orders', 'csv');
  expect(csv.status).toBe(200);
  const text = await csv.text();
  expect(parseCsv(text)).toHaveLength((total ?? 0) + 1);
  expect(text).toContain(longEmail);
  const json = await exportReport(db, 'orders', 'json');
  expect(json.status).toBe(200);
  const body = (await json.json()) as { rows: unknown[] };
  expect(body.rows).toHaveLength(total ?? 0);
}, 240_000);

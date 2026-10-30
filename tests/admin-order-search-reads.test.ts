import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { meterRowsRead } from './helpers/rows-read';
import { adminOrderDiscovery } from '../web/src/server/admin-order-discovery';

const ORDERS = 50_000;
const PAGE = 50;

let db: D1Database, dispose: () => Promise<void>;
beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  // About 70 orders a day from 2025-01-01, numbered ORD-YYMMDD-XXXXXX from created_at's
  // UTC date like checkout.ts. Suffixes fall during each day, so number order is not
  // date order.
  await db
    .prepare(
      `INSERT INTO orders (id, number, status, payment_status, customer_email, currency,
                           subtotal_cents, total_cents, created_at, updated_at)
       SELECT 'o' || value,
              'ORD-' || substr(strftime('%Y%m%d', '2025-01-01', '+' || (value * 1234) || ' seconds'), 3)
                     || '-' || printf('%06d', 999999 - value),
              'paid', 'paid', 'b' || value || '@example.com', 'USD', 1000, 1000,
              strftime('%Y-%m-%dT%H:%M:%fZ', '2025-01-01', '+' || (value * 1234) || ' seconds'),
              '2026-01-01'
       FROM json_each(?)`
    )
    .bind(JSON.stringify(Array.from({ length: ORDERS }, (_, i) => i)))
    .run();
  // checkout.ts stamps created_at before it draws the number, so an order can be
  // numbered for the day after its created_at.
  await db
    .prepare(
      `INSERT INTO orders (id, number, status, payment_status, customer_email, currency,
                           subtotal_cents, total_cents, created_at, updated_at)
       VALUES ('oskew', 'ORD-261101-SKEW01', 'paid', 'paid', 'skew@example.com', 'USD',
               1000, 1000, '2026-10-31T23:59:59.990Z', '2026-01-01')`
    )
    .run();
}, 60_000);
afterAll(async () => dispose());

const orderReads = (sql: string) => sql.includes('FROM orders o');

it('"ORD-26" reads ≤ one page (51) at 50k orders', async () => {
  const meter = meterRowsRead(db);
  const found = await adminOrderDiscovery(meter.db, { q: 'ORD-26' });
  expect(found.orders).toHaveLength(PAGE);
  expect(found.orders.every((order) => order.number.startsWith('ORD-26'))).toBe(true);
  expect(meter.rowsRead(orderReads)).toBeLessThanOrEqual(PAGE + 1);
});

it('an ORD- prefix search returns the newest orders first', async () => {
  const found = await adminOrderDiscovery(db, { q: 'ORD-2610', view: 'all' });
  const newest = await db
    .prepare(
      `SELECT number FROM orders WHERE number LIKE 'ORD-2610%'
       ORDER BY created_at DESC, id DESC LIMIT ${PAGE}`
    )
    .all<{ number: string }>();
  expect(found.orders.map((order) => order.number)).toEqual(
    newest.results.map((row) => row.number)
  );
});

it('a full order number reads ≤ one page', async () => {
  const one = await db
    .prepare("SELECT number FROM orders WHERE number LIKE 'ORD-261030-%' LIMIT 1")
    .first<{ number: string }>();
  const meter = meterRowsRead(db);
  const found = await adminOrderDiscovery(meter.db, { q: one?.number ?? '', view: 'all' });
  expect(found.orders.map((order) => order.number)).toEqual([one?.number]);
  expect(meter.rowsRead(orderReads)).toBeLessThanOrEqual(PAGE + 1);
});

it.each(['ORD-2610', 'ORD-2611', 'ORD-261101'])(
  'an ORD- prefix (%s) pages through every match exactly once, newest first',
  async (q) => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const found = await adminOrderDiscovery(db, { q, view: 'all', cursor });
      seen.push(...found.orders.map((order) => order.number));
      cursor = found.nextCursor ?? undefined;
    } while (cursor);
    const expected = await db
      .prepare(
        `SELECT number FROM orders WHERE number LIKE ? || '%' ORDER BY created_at DESC, id DESC`
      )
      .bind(q)
      .all<{ number: string }>();
    expect(seen).toEqual(expected.results.map((row) => row.number));
  },
  60_000
);

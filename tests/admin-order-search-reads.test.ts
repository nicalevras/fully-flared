import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { meterRowsRead } from './helpers/rows-read';
import { adminOrderDiscovery } from '../web/src/server/admin-order-discovery';

const ORDERS = 50_000;
const PAGE = 50;

let db: D1Database, dispose: () => Promise<void>;
beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  // About 70 orders a day from 2025-01-01, numbered ORD-YYMMDD-XXXXXX like checkout.ts.
  await db
    .prepare(
      `INSERT INTO orders (id, number, status, payment_status, customer_email, currency,
                           subtotal_cents, total_cents, created_at, updated_at)
       SELECT 'o' || value,
              'ORD-' || substr(strftime('%Y%m%d', '2025-01-01', '+' || (value / 70) || ' days'), 3)
                     || '-' || printf('%06d', value),
              'paid', 'paid', 'b' || value || '@example.com', 'USD', 1000, 1000,
              strftime('%Y-%m-%dT%H:%M:%fZ', '2025-01-01', '+' || (value * 20) || ' minutes'),
              '2026-01-01'
       FROM json_each(?)`
    )
    .bind(JSON.stringify(Array.from({ length: ORDERS }, (_, i) => i)))
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

it('an ORD- prefix pages through every match exactly once', async () => {
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const found = await adminOrderDiscovery(db, { q: 'ORD-2610', view: 'all', cursor });
    seen.push(...found.orders.map((order) => order.number));
    cursor = found.nextCursor ?? undefined;
  } while (cursor);
  const expected = await db
    .prepare("SELECT number FROM orders WHERE number LIKE 'ORD-2610%'")
    .all<{ number: string }>();
  expect(seen).toHaveLength(expected.results.length);
  expect(new Set(seen)).toEqual(new Set(expected.results.map((row) => row.number)));
}, 60_000);

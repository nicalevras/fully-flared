import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { dashboardStats, paidRevenueByCurrency } from '../web/src/server/reports';
import { exportReport } from '../web/src/routes/api/reports';

let db: D1Database, dispose: () => Promise<void>;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  const order = (
    id: string,
    total: number,
    currency: string,
    created: string,
    payment = 'paid',
    status = 'paid'
  ) =>
    db
      .prepare(
        `INSERT INTO orders (id, number, status, payment_status, customer_email, currency, subtotal_cents, total_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'a@example.invalid', ?, ?, ?, ?, ?)`
      )
      .bind(id, id, status, payment, currency, total, total, created, created)
      .run();
  await order('o1', 10000, 'USD', '2026-06-10T12:00:00.000Z');
  await order('o2', 5000, 'USD', '2026-06-11T12:00:00.000Z');
  await order('o3', 7000, 'EUR', '2026-06-11T12:00:00.000Z');
  await order('o4', 99900, 'USD', '2026-06-11T12:00:00.000Z', 'unpaid', 'pending_payment');
});
afterEach(async () => {
  await dispose();
});

describe('Phase 17B report reconciliation', () => {
  it('dashboard gross, sales by day export, and all time revenue agree per currency', async () => {
    const dashboard = await dashboardStats(
      db,
      '2026-06-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z'
    );
    const allTime = await paidRevenueByCurrency(db);
    const response = await exportReport(db, 'sales', 'csv');
    expect(response.status).toBe(200);
    const csv = await response.text();
    const lines = csv.trim().split('\n');
    const header = lines[0]!.split(',');
    const dayIdx = header.indexOf('day');
    const totalIdx = header.indexOf('total_cents');
    const currencyIdx = header.indexOf('currency');
    const ordersIdx = header.indexOf('orders');
    expect(dayIdx).toBeGreaterThanOrEqual(0);
    const exported = new Map<string, { total: number; orders: number }>();
    for (const line of lines.slice(1)) {
      const cells = line.split(',');
      const currency = cells[currencyIdx]!;
      const row = exported.get(currency) ?? { total: 0, orders: 0 };
      row.total += Number(cells[totalIdx]);
      row.orders += Number(cells[ordersIdx]);
      exported.set(currency, row);
    }
    for (const row of dashboard) {
      expect(exported.get(row.currency)).toEqual({
        total: row.grossCents,
        orders: row.paidOrders,
      });
      const all = allTime.find((r) => r.currency === row.currency);
      expect(all?.revenue).toBe(row.grossCents);
      expect(all?.orders).toBe(row.paidOrders);
    }
    expect(exported.has('USD')).toBe(true);
    expect(exported.get('USD')?.total).toBe(15000);
  });
});

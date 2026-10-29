import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { dashboardStats } from '../web/src/server/reports';

let db: D1Database, dispose: () => Promise<void>;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  const order = (id: string, total: number, currency: string, created: string) =>
    db
      .prepare(
        `INSERT INTO orders (id, number, status, payment_status, customer_email, currency, subtotal_cents, total_cents, created_at, updated_at)
         VALUES (?, ?, 'paid', 'paid', 'a@example.invalid', ?, ?, ?, ?, ?)`
      )
      .bind(id, id, currency, total, total, created, created)
      .run();
  await order('o1', 10000, 'USD', '2026-06-10T12:00:00.000Z');
  await order('o2', 5000, 'USD', '2026-05-01T12:00:00.000Z');
  await order('o3', 7000, 'EUR', '2026-06-11T12:00:00.000Z');
  await db
    .prepare(
      `INSERT INTO refunds (id, order_id, purpose, amount_cents, status, created_at)
       VALUES ('r1', 'o2', 'staff', 2000, 'succeeded', '2026-06-12T12:00:00.000Z'),
              ('r2', 'o1', 'staff', 9000, 'pending', '2026-06-12T12:00:00.000Z')`
    )
    .run();
});
afterEach(async () => {
  await dispose();
});

describe('Phase 17A dashboard stats', () => {
  it('separates currencies and attributes refunds to the refund period', async () => {
    const stats = await dashboardStats(db, '2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    expect(stats).toEqual([
      {
        currency: 'EUR',
        grossCents: 7000,
        refundCents: 0,
        netCents: 7000,
        paidOrders: 1,
        aovCents: 7000,
      },
      {
        currency: 'USD',
        grossCents: 10000,
        refundCents: 2000,
        netCents: 8000,
        paidOrders: 1,
        aovCents: 10000,
      },
    ]);
  });

  it('recovery refunds without a committed sale do not reduce net revenue', async () => {
    await db
      .prepare(
        `INSERT INTO orders (id, number, status, payment_status, customer_email, currency, subtotal_cents, total_cents, created_at, updated_at)
         VALUES ('o9', 'o9', 'canceled', 'unpaid', 'a@example.invalid', 'USD', 10000, 10000, '2026-06-10T12:00:00.000Z', '2026-06-10T12:00:00.000Z'),
                ('o10', 'o10', 'paid', 'paid', 'a@example.invalid', 'USD', 4000, 4000, '2026-06-10T12:00:00.000Z', '2026-06-10T12:00:00.000Z')`
      )
      .run();
    await db
      .prepare(
        `INSERT INTO refunds (id, order_id, purpose, amount_cents, status, created_at)
         VALUES ('r9', 'o9', 'late_payment', 10000, 'succeeded', '2026-06-12T12:00:00.000Z'),
                ('r10', 'o10', 'late_payment', 4000, 'succeeded', '2026-06-12T12:00:00.000Z')`
      )
      .run();
    await db
      .prepare(
        `INSERT INTO reservations (id, order_id, sku, qty, status, expires_at, created_at)
         VALUES ('s10', 'o10', 'TEE-1', 1, 'committed', '2027-01-01', '2026-06-10')`
      )
      .run();
    const stats = await dashboardStats(db, '2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    const usd = stats.find((s) => s.currency === 'USD');
    // o9's recovery refund is excluded (no committed sale); o10's counts.
    expect(usd).toMatchObject({ grossCents: 14000, refundCents: 6000, netCents: 8000 });
  });

  it('excludes orders outside the period', async () => {
    const stats = await dashboardStats(db, '2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    expect(stats).toEqual([
      {
        currency: 'USD',
        grossCents: 5000,
        refundCents: 0,
        netCents: 5000,
        paidOrders: 1,
        aovCents: 5000,
      },
    ]);
  });
});

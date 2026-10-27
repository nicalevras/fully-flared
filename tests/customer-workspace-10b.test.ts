import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { getCustomerWorkspace } from '../web/src/server/admin-customer-workspace';

let db: D1Database, dispose: () => Promise<void>;

async function insertOrder(
  id: string,
  userId: string | null,
  currency: string,
  total: number,
  status = 'paid'
) {
  await db
    .prepare(
      `INSERT INTO orders (id, number, status, payment_status, customer_email, user_id, currency, subtotal_cents, total_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ada@example.com', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    )
    .bind(
      id,
      `FF-${id}`,
      status,
      status === 'pending_payment' ? 'unpaid' : 'paid',
      userId,
      currency,
      total,
      total
    )
    .run();
}

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await db
    .prepare(
      "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('u1', 'Ada', 'ada@example.com', 1, 'customer', 1, 1)"
    )
    .run();
  await insertOrder('a1', 'u1', 'USD', 2000);
  await insertOrder('a2', 'u1', 'EUR', 3000);
  await insertOrder('a3', 'u1', 'USD', 500, 'pending_payment');
  await insertOrder('g1', null, 'USD', 9900);
});
afterEach(async () => {
  await dispose();
});

describe('Phase 10B customer workspace', () => {
  it('keeps currencies separate and excludes guest orders and unpaid sales from totals', async () => {
    const ws = await getCustomerWorkspace(db, 'u1');
    expect(ws.profile?.email).toBe('ada@example.com');
    expect(ws.orders.map((o) => o.id)).toEqual(['a3', 'a2', 'a1']);
    expect(ws.totals).toEqual([
      { currency: 'EUR', orders: 1, spent_cents: 3000 },
      { currency: 'USD', orders: 1, spent_cents: 2000 },
    ]);
  });

  it('returns an empty workspace for a missing account', async () => {
    const ws = await getCustomerWorkspace(db, 'missing');
    expect(ws.profile).toBeNull();
    expect(ws.orders).toEqual([]);
  });
});

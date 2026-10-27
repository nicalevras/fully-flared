import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { adminOrderDiscovery } from '../web/src/server/admin-order-discovery';

let db: D1Database, dispose: () => Promise<void>;

async function insertOrder(
  id: string,
  number: string,
  email: string,
  status: string,
  payment: string,
  created: string
) {
  await db
    .prepare(
      `INSERT INTO orders (id, number, status, payment_status, customer_email, currency, subtotal_cents, total_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'USD', 1000, 1000, ?, ?)`
    )
    .bind(id, number, status, payment, email, created, created)
    .run();
}

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await insertOrder('o1', 'FF-1001', 'ada@example.com', 'paid', 'paid', '2026-01-03T00:00:00.000Z');
  await insertOrder(
    'o2',
    'FF-1002',
    'ada@example.com',
    'processing',
    'paid',
    '2026-01-03T00:00:00.000Z'
  );
  await insertOrder(
    'o3',
    'FF-1003',
    'grace@example.com',
    'shipped',
    'paid',
    '2026-01-02T00:00:00.000Z'
  );
  await insertOrder(
    'o4',
    'FF-1004',
    'bad@example.com',
    'pending_payment',
    'failed',
    '2026-01-01T00:00:00.000Z'
  );
});
afterEach(async () => {
  await dispose();
});

describe('Phase 7 order discovery', () => {
  it('shows the paid and unfulfilled queue by default', async () => {
    const result = await adminOrderDiscovery(db, {});
    expect(result.orders.map((o) => o.number)).toEqual(['FF-1002', 'FF-1001']);
  });

  it('finds orders by number prefix and by email prefix', async () => {
    const byNumber = await adminOrderDiscovery(db, { view: 'all', q: 'FF-1003' });
    expect(byNumber.orders.map((o) => o.number)).toEqual(['FF-1003']);
    const byEmail = await adminOrderDiscovery(db, { view: 'all', q: 'ada@' });
    expect(byEmail.orders.map((o) => o.number)).toEqual(['FF-1002', 'FF-1001']);
  });

  it('isolates payment issues and applies date filters', async () => {
    const issues = await adminOrderDiscovery(db, { view: 'payment-issues' });
    expect(issues.orders.map((o) => o.number)).toEqual(['FF-1004']);
    const dated = await adminOrderDiscovery(db, {
      view: 'all',
      from: '2026-01-02',
      to: '2026-01-02',
    });
    expect(dated.orders.map((o) => o.number)).toEqual(['FF-1003']);
  });

  it('rejects a cursor from another query', async () => {
    const first = await adminOrderDiscovery(db, { view: 'all' });
    expect(first.orders).toHaveLength(4);
    const stale = await adminOrderDiscovery(db, {
      view: 'all',
      q: 'FF-1001',
      cursor: 'not-a-cursor',
    });
    expect(stale.orders.map((o) => o.number)).toEqual(['FF-1001']);
  });

  it('pages across tied timestamps without duplicates or gaps', async () => {
    for (let i = 0; i < 60; i++) {
      await insertOrder(
        `x${i}`,
        `FF-20${String(i).padStart(2, '0')}`,
        'bulk@example.com',
        'paid',
        'paid',
        '2026-02-01T00:00:00.000Z'
      );
    }
    const first = await adminOrderDiscovery(db, { view: 'all', q: 'bulk@' });
    expect(first.orders).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const second = await adminOrderDiscovery(db, {
      view: 'all',
      q: 'bulk@',
      cursor: first.nextCursor,
    });
    expect(second.orders).toHaveLength(10);
    const seen = new Set([...first.orders, ...second.orders].map((o) => o.id));
    expect(seen.size).toBe(60);
    const back = await adminOrderDiscovery(db, {
      view: 'all',
      q: 'bulk@',
      cursor: second.previousCursor,
    });
    expect(back.orders.map((o) => o.id)).toEqual(first.orders.map((o) => o.id));
  });

  it('loads returns only in the returns view', async () => {
    const queue = await adminOrderDiscovery(db, {});
    expect(queue.returns).toEqual([]);
  });
});

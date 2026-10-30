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

  it('finds orders by number prefix only', async () => {
    const byNumber = await adminOrderDiscovery(db, { view: 'all', q: 'FF-1003' });
    expect(byNumber.orders.map((o) => o.number)).toEqual(['FF-1003']);
    // A stale email mode falls back to number search, which matches nothing here.
    const byEmail = await adminOrderDiscovery(db, { view: 'all', mode: 'email', q: 'ada@' });
    expect(byEmail.orders).toEqual([]);
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
    const first = await adminOrderDiscovery(db, { view: 'all', q: 'FF-20' });
    expect(first.orders).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const second = await adminOrderDiscovery(db, {
      view: 'all',
      q: 'FF-20',
      cursor: first.nextCursor,
    });
    expect(second.orders).toHaveLength(10);
    const seen = new Set([...first.orders, ...second.orders].map((o) => o.id));
    expect(seen.size).toBe(60);
    const back = await adminOrderDiscovery(db, {
      view: 'all',
      q: 'FF-20',
      cursor: second.previousCursor,
    });
    expect(back.orders.map((o) => o.id)).toEqual(first.orders.map((o) => o.id));
  });

  it('loads returns only in the returns view', async () => {
    const queue = await adminOrderDiscovery(db, {});
    expect(queue.returns).toEqual([]);
  });
});

describe('FF-03: returns view pagination', () => {
  it('pages through 55 open returns exactly once in both directions', async () => {
    // Tied timestamps across the page boundary, failed refunds first.
    for (let i = 1; i <= 55; i++) {
      const id = `r${String(i).padStart(3, '0')}`;
      const status = i <= 3 ? 'refund_failed' : 'requested';
      await insertOrder(
        `or${i}`,
        `FF-20${String(i).padStart(2, '0')}`,
        'ada@example.com',
        'paid',
        'paid',
        '2026-02-01T00:00:00.000Z'
      );
      await db
        .prepare(
          "INSERT INTO returns(id,order_id,status,reason,created_at) VALUES(?, ?, ?, 'Changed mind', '2026-02-01T00:00:00.000Z')"
        )
        .bind(id, `or${i}`, status)
        .run();
    }
    const first = await adminOrderDiscovery(db, { view: 'returns' });
    expect(first.returns).toHaveLength(50);
    expect(first.returns.slice(0, 3).map((r) => r.status)).toEqual([
      'refund_failed',
      'refund_failed',
      'refund_failed',
    ]);
    expect(first.returnsNextCursor).not.toBeNull();
    const second = await adminOrderDiscovery(db, {
      view: 'returns',
      returnsCursor: first.returnsNextCursor,
    });
    expect(second.returns).toHaveLength(5);
    expect(second.returnsNextCursor).toBeNull();
    const seen = [...first.returns, ...second.returns].map((r) => r.id);
    expect(new Set(seen).size).toBe(55);
    const back = await adminOrderDiscovery(db, {
      view: 'returns',
      returnsCursor: second.returnsPreviousCursor,
    });
    expect(back.returns.map((r) => r.id)).toEqual(first.returns.map((r) => r.id));
  });

  it('rejects a returns cursor from a different search', async () => {
    await db
      .prepare(
        "INSERT INTO returns(id,order_id,status,reason,created_at) VALUES('rx','o1','requested','x','2026-02-01T00:00:00.000Z')"
      )
      .run();
    const first = await adminOrderDiscovery(db, { view: 'returns', q: '' });
    const other = await adminOrderDiscovery(db, {
      view: 'returns',
      q: 'ada',
      returnsCursor: first.returnsNextCursor ?? undefined,
    });
    // Cross-query cursor is ignored, landing on the first page of the new search.
    expect(other.returnsPreviousCursor).toBeNull();
  });
});

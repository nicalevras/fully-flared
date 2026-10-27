import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { globalSearch } from '../web/src/server/admin-global-search';

let db: D1Database, dispose: () => Promise<void>;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 10 });
  await db
    .prepare(
      `INSERT INTO orders (id, number, status, payment_status, customer_email, currency, subtotal_cents, total_cents, created_at, updated_at)
       VALUES ('o1', 'FF-1001', 'paid', 'paid', 'tee@example.invalid', 'USD', 1000, 1000, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`
    )
    .run();
});
afterEach(async () => {
  await dispose();
});

describe('Phase 18 global search', () => {
  it('finds a product by title and by SKU prefix', async () => {
    const byTitle = await globalSearch(db, 'tee', { orders: true, customers: true });
    expect(byTitle.products.map((p) => p.id)).toContain('p1');
    const bySku = await globalSearch(db, 'TEE', { orders: true, customers: true });
    expect(bySku.products.map((p) => p.id)).toContain('p1');
  });

  it('finds an order by number and a guest contact by email', async () => {
    const byNumber = await globalSearch(db, 'FF-100', { orders: true, customers: true });
    expect(byNumber.orders.map((o) => o.number)).toEqual(['FF-1001']);
    const byEmail = await globalSearch(db, 'tee@example', { orders: true, customers: true });
    expect(byEmail.customers).toEqual([
      { email: 'tee@example.invalid', accountId: null, guestOrderCount: 1, accountOrderCount: 0 },
    ]);
  });

  it('respects permission gates and short queries', async () => {
    const gated = await globalSearch(db, 'FF-100', { orders: false, customers: false });
    expect(gated.orders).toEqual([]);
    expect(gated.customers).toEqual([]);
    const short = await globalSearch(db, 't', { orders: true, customers: true });
    expect(short).toEqual({ products: [], orders: [], customers: [] });
  });
});

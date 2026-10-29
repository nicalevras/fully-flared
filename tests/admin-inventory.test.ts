import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { adminInventoryList } from '../web/src/server/admin-inventory';

let db: D1Database, dispose: () => Promise<void>;
const now = '2026-01-01T00:00:00.000Z';

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 5 });
  await db.batch([
    db
      .prepare(
        `INSERT INTO products (id, slug, title, description, status, created_at, updated_at) VALUES ('p2', 'hat', 'Hat', '', 'active', ?, ?)`
      )
      .bind(now, now),
    db
      .prepare(
        `INSERT INTO variants (id, product_id, sku, title, price_cents, status, continue_selling, created_at) VALUES ('v2', 'p2', 'HAT-1', 'Blue', 3000, 'active', 0, ?)`
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO variants (id, product_id, sku, title, price_cents, status, continue_selling, created_at) VALUES ('v3', 'p2', 'HAT-2', 'Red', 3000, 'active', 0, ?)`
      )
      .bind(now),
    db
      .prepare(`INSERT INTO stock (sku, on_hand, reserved, updated_at) VALUES ('HAT-1', 20, 2, ?)`)
      .bind(now),
    db
      .prepare(
        `INSERT INTO products (id, slug, title, description, status, created_at, updated_at) VALUES ('p3', 'mug', 'Mug', '', 'active', ?, ?)`
      )
      .bind(now, now),
    db
      .prepare(
        `INSERT INTO variants (id, product_id, sku, title, price_cents, status, continue_selling, created_at) VALUES ('v4', 'p3', 'MUG-1', 'Default', 1500, 'active', 0, ?)`
      )
      .bind(now),
    db
      .prepare(`INSERT INTO stock (sku, on_hand, reserved, updated_at) VALUES ('MUG-1', 10, 0, ?)`)
      .bind(now),
  ]);
});
afterEach(async () => {
  await dispose();
});

describe('grouped inventory list', () => {
  it('groups SKUs under products with summed counts and zeros for a missing stock row', async () => {
    const result = await adminInventoryList(db, { q: '', page: 1, low: false });
    expect(result.total).toBe(3);
    const hat = result.products.find((p) => p.id === 'p2');
    expect(hat).toMatchObject({
      variantCount: 2,
      onHand: 20,
      reserved: 2,
      available: 18,
      lowCount: 1,
    });
    expect(hat?.skus.find((s) => s.sku === 'HAT-2')).toMatchObject({
      onHand: 0,
      reserved: 0,
      available: 0,
    });
    expect(hat?.skus.find((s) => s.sku === 'HAT-1')?.available).toBe(18);
  });

  it('paginates by product', async () => {
    for (let i = 1; i <= 25; i++) {
      await db
        .prepare(
          `INSERT INTO products (id, slug, title, description, status, created_at, updated_at) VALUES (?, ?, ?, '', 'draft', ?, ?)`
        )
        .bind(`px${i}`, `item-${i}`, `Item ${String(i).padStart(2, '0')}`, now, now)
        .run();
    }
    const page1 = await adminInventoryList(db, { q: '', page: 1, low: false });
    expect(page1.products).toHaveLength(25);
    const page2 = await adminInventoryList(db, { q: '', page: 2, low: false });
    expect(page2.total).toBe(28);
    expect(page2.products).toHaveLength(3);
    expect(page1.products.map((p) => p.id)).not.toContain(page2.products[0]?.id);
  });

  it('low-stock filter keeps only products with a SKU at 5 or fewer available', async () => {
    const result = await adminInventoryList(db, { q: '', page: 1, low: true });
    expect(result.products.map((p) => p.title).sort()).toEqual(['Hat', 'Tee']);
  });

  it('SKU prefix search returns the product with its matched SKUs', async () => {
    const result = await adminInventoryList(db, { q: 'HAT-', page: 1, low: false });
    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.matchedSkus).toEqual(['HAT-1', 'HAT-2']);
    const byTitle = await adminInventoryList(db, { q: 'mug', page: 1, low: false });
    expect(byTitle.products.map((p) => p.title)).toEqual(['Mug']);
    expect(byTitle.products[0]?.matchedSkus).toEqual(['MUG-1']);
  });
});

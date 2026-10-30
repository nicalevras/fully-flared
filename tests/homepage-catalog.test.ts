import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from './helpers/d1';
import { pageWindow } from '../web/src/lib/catalog-page';
import { getShopProductsPage } from '../web/src/server/catalog-read';
import { buildCatalogReadModels } from './helpers/catalog-driver';

describe('pageWindow', () => {
  it('paginates and clamps into range', () => {
    expect(pageWindow(25, 1, 24)).toEqual({ page: 1, pageCount: 2, offset: 0 });
    expect(pageWindow(25, 2, 24)).toEqual({ page: 2, pageCount: 2, offset: 24 });
    expect(pageWindow(25, 99, 24).page).toBe(2);
    expect(pageWindow(25, 0, 24).page).toBe(1);
    expect(pageWindow(0, 1, 24)).toEqual({ page: 1, pageCount: 1, offset: 0 });
  });
});

describe('homepage catalogue D1 fallback path', () => {
  let db: D1Database, dispose: () => Promise<void>;

  beforeAll(async () => {
    ({ db, dispose } = await createTestDb());
    const statements: D1PreparedStatement[] = [];
    for (let i = 1; i <= 25; i++) {
      const day = String(i).padStart(2, '0');
      statements.push(
        db
          .prepare(
            `INSERT INTO products (id, slug, title, description, status, created_at, updated_at)
             VALUES (?, ?, ?, '', 'active', ?, ?)`
          )
          .bind(
            `p${i}`,
            `prod-${i}`,
            `Product ${i}`,
            `2026-01-${day}T00:00:00.000Z`,
            `2026-01-${day}T00:00:00.000Z`
          ),
        db
          .prepare(
            `INSERT INTO variants (id, product_id, sku, title, price_cents, status, created_at)
             VALUES (?, ?, ?, 'Default', 1000, 'active', '2026-01-01')`
          )
          .bind(`v${i}`, `p${i}`, `SKU-${i}`)
      );
    }
    await db.batch(statements);
    await buildCatalogReadModels(db, undefined);
  });

  afterAll(async () => {
    await dispose();
  });

  it('pages the complete catalogue with a true total (no KV, no 500-cap slice)', async () => {
    const first = await getShopProductsPage(db, {}, 1);
    expect(first.products).toHaveLength(24);
    expect(first.total).toBe(25);
    expect(first.pageCount).toBe(2);

    const second = await getShopProductsPage(db, {}, 2);
    expect(second.products.map((p) => p.slug)).toEqual(['prod-1']);
    expect(second.total).toBe(25);
  });

  it('/shop wires search pagination and the paged loader; home has neither', () => {
    const route = readFileSync('web/src/routes/_shop.shop.tsx', 'utf8');
    expect(route).toContain('validateSearch: storefrontPageSearch');
    expect(route).toContain('stripSearchParams({ page: 1 })');
    expect(route).toContain('loaderDeps: ({ search: { page } }) => ({ page })');
    expect(route).toContain('getShopProductsPage');
    expect(route).toContain('to="/shop" search={{ page: page + 1 }}');
    const home = readFileSync('web/src/routes/_shop.index.tsx', 'utf8');
    expect(home).not.toContain('validateSearch');
    expect(home).not.toContain('getShopProductsPage');
  });
});

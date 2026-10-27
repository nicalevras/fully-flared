import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDb, seedProduct } from './helpers/d1';
import { adminProductDiscovery } from '../web/src/server/admin-product-discovery';
import { normalizeProductSearch } from '../web/src/lib/product-search';

describe('Phase 13 collections product picker', () => {
  it('no longer caps the picker at the first 200 products', () => {
    const source = readFileSync('web/src/routes/admin/collections.tsx', 'utf8');
    expect(source).not.toContain('LIMIT 200');
    expect(source).toContain('adminProductDiscovery');
  });

  it('finds a product by title through the shared discovery search', async () => {
    const { db, dispose } = await createTestDb();
    try {
      await seedProduct(db, {});
      const result = await adminProductDiscovery(
        db,
        normalizeProductSearch({ q: 'Tee', mode: 'title' })
      );
      expect(result.products.map((p) => p.title)).toContain('Tee');
    } finally {
      await dispose();
    }
  });
});

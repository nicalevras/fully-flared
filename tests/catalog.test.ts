import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { listProducts } from '../web/src/server/catalog';
import { readListingPage, readProductDocument } from '../web/src/server/catalog-read';
import { ALL_LISTING } from '../web/src/server/catalog-models';

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  await seedProduct(db);
  await db
    .prepare(
      "INSERT INTO collections (id, slug, title, description, kind, created_at) VALUES ('c1', 'tees', 'Tees', '', 'manual', ?)"
    )
    .bind(new Date().toISOString())
    .run();
  await db
    .prepare("INSERT INTO product_collections (product_id, collection_id) VALUES ('p1', 'c1')")
    .run();
});
afterAll(async () => {
  await dispose();
});

describe('catalog typed queries', () => {
  it('lists active products with min price, availability, and first image slot', async () => {
    const rows = await listProducts(db, { status: 'active' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: 'tee', priceCents: 2000, available: 5 });
  });

  it('FTS search finds the product by title term', async () => {
    const rows = await listProducts(db, { status: 'active', search: 'Tee' });
    expect(rows.map((r) => r.slug)).toEqual(['tee']);
    const none = await listProducts(db, { status: 'active', search: 'nonexistentterm' });
    expect(none).toEqual([]);
  });

  it('loads the published product detail with variants and separate stock availability', async () => {
    await buildCatalogReadModels(db, undefined);
    const detail = await readProductDocument(db, undefined, 'tee');
    expect(detail?.variants).toHaveLength(1);
    expect(detail?.variants[0]).toMatchObject({ sku: 'TEE-1', priceCents: 2000 });
    expect(detail?.variants[0]).not.toHaveProperty('available');
    expect(await readProductDocument(db, undefined, 'missing')).toBeNull();
  });

  it('KV-miss fallback is bounded: D1 page payloads, cards only', async () => {
    await buildCatalogReadModels(db, undefined);
    const page = await readListingPage(db, undefined, ALL_LISTING, 1);
    expect(page?.cards.map((p) => p.slug)).toEqual(['tee']);
    // Cards carry no inventory; product pages do their own bounded
    // targeted document read (asserted in the detail tests above).
    expect(JSON.stringify(page)).not.toContain('available');
  });
});

describe('partitioned build past the D1 bound-parameter limit', () => {
  it('builds documents for 250 products (no id list is bound)', { timeout: 120_000 }, async () => {
    const ts = new Date().toISOString();
    let stmts: D1PreparedStatement[] = [];
    for (let i = 1; i <= 250; i++) {
      stmts.push(
        db
          .prepare(
            "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) VALUES (?, ?, ?, 'd', 'active', ?, ?)"
          )
          .bind('cp' + i, 'cat-' + i, 'Catalog ' + i, ts, ts),
        db
          .prepare(
            "INSERT INTO variants (id, product_id, sku, title, price_cents, status, continue_selling, created_at) VALUES (?, ?, ?, 'V', 1000, 'active', 0, ?)"
          )
          .bind('cv' + i, 'cp' + i, 'CAT-' + i, ts),
        db
          .prepare('INSERT INTO stock (sku, on_hand, reserved, updated_at) VALUES (?, 3, 0, ?)')
          .bind('CAT-' + i, ts)
      );
      if (stmts.length >= 60) {
        await db.batch(stmts);
        stmts = [];
      }
    }
    for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
    const map = new Map<string, string>();
    const kv = {
      get: async (k: string) => map.get(k) ?? null,
      put: async (k: string, v: string) => {
        map.set(k, v);
      },
      delete: async (k: string) => {
        map.delete(k);
      },
    };
    const result = await buildCatalogReadModels(db, kv);
    expect(result.products).toBeGreaterThanOrEqual(250);
    const doc = await readProductDocument(db, kv, 'cat-250');
    expect(doc?.variants[0]?.sku).toBe('CAT-250');
  });
});
import { buildCatalogReadModels } from './helpers/catalog-driver';

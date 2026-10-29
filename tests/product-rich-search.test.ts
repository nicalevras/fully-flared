import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';
import { searchCatalog } from '../web/src/server/catalog-discovery';
import { adminProductDiscovery } from '../web/src/server/admin-product-discovery';

let db: D1Database, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => {
  await dispose();
});

describe('product rich text search index', () => {
  it('indexes visible words only, on the storefront and in admin discovery', async () => {
    const created = await runAdminAction(db, {} as never, owner, 'product.create', {
      title: 'Searchable Tee',
      slug: 'searchable-tee',
      description:
        '<p>Soft <strong>cotton</strong> tee</p><p><img src="/media/heroimage.png" alt="Hero"></p>',
      status: 'active',
      seoTitle: '',
      seoDescription: '',
      variants: [
        {
          sku: 'SEARCH-1',
          title: 'Default',
          priceCents: 2000,
          stock: 1,
          weightGrams: null,
          continueSelling: false,
        },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const productId = (created.data as { productId: string }).productId;
    const row = await db
      .prepare('SELECT description_text FROM products WHERE id = ?')
      .bind(productId)
      .first<{ description_text: string }>();
    expect(row?.description_text).toBe('Soft cotton tee');

    await db
      .prepare(
        `INSERT INTO catalog_cards (product_id, slug, card_json, revision, doc_revision, updated_at)
         VALUES (?, 'searchable-tee', ?, 'r', 'r', '2026-01-01')`
      )
      .bind(
        productId,
        JSON.stringify({ id: productId, slug: 'searchable-tee', title: 'Searchable Tee' })
      )
      .run();

    expect((await searchCatalog(db, {}, 'cotton')).cards.map((c) => c.id)).toEqual([productId]);
    for (const term of ['strong', 'img', 'heroimage']) {
      expect((await searchCatalog(db, {}, term)).cards).toEqual([]);
      const admin = await adminProductDiscovery(db, { q: term, mode: 'title' });
      expect(admin.products.map((p) => p.id)).not.toContain(productId);
    }

    // A plain update stays byte-identical in both columns and indexes literally.
    const plain = 'Plain cotton with <b>literal</b> text';
    const updated = await runAdminAction(db, {} as never, owner, 'product.update', {
      productId,
      title: 'Searchable Tee',
      slug: 'searchable-tee',
      description: plain,
      status: 'active',
    });
    expect(updated.ok).toBe(true);
    const after = await db
      .prepare('SELECT description, description_text FROM products WHERE id = ?')
      .bind(productId)
      .first<{ description: string; description_text: string }>();
    expect(after?.description).toBe(plain);
    expect(after?.description_text).toBe(plain);
    expect((await searchCatalog(db, {}, 'literal')).cards.map((c) => c.id)).toEqual([productId]);
  });
});

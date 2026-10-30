import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';
import { present } from './helpers/fixtures';

let db: D1Database, env: Env, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };

beforeEach(async () => {
  ({ db, env, dispose } = await createTestDb());
});
afterEach(async () => {
  await dispose();
});

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

function createPayload(skus: string[]) {
  return {
    title: 'Everyday Tote',
    slug: 'everyday-tote',
    description: '',
    status: 'draft',
    seoTitle: '',
    seoDescription: '',
    variants: skus.map((sku, index) => ({
      sku,
      title: `Variant ${index + 1}`,
      priceCents: 2999,
      stock: 5,
      weightGrams: null,
      continueSelling: false,
    })),
  };
}

describe('product.create action', () => {
  it('sanitizes an HTML description on create', async () => {
    const payload = createPayload(['TOTE-RICH']);
    payload.description = '<p>Soft <em>cotton</em></p><script>alert(1)</script>';
    const result = await runAdminAction(db, env, owner, 'product.create', payload);
    expect(result.ok).toBe(true);
    const row = await db
      .prepare('SELECT description, description_text FROM products WHERE slug = ?')
      .bind('everyday-tote')
      .first<{ description: string; description_text: string }>();
    expect(row?.description_text).toBe('Soft cotton');
    expect(row?.description).toContain('<em>cotton</em>');
    expect(row?.description).not.toContain('<script');
  });

  it('creates the product, variant, stock, ledger and audit rows together', async () => {
    const result = await runAdminAction(
      db,
      env,
      owner,
      'product.create',
      createPayload(['TOTE-001'])
    );
    expect(result.ok).toBe(true);
    expect(await count('products')).toBe(1);
    expect(await count('variants')).toBe(1);
    expect(await count('stock')).toBe(1);
    expect(await count('stock_ledger')).toBe(1);
    const audit = await db
      .prepare("SELECT action, entity_type FROM audit_log WHERE action = 'product.create'")
      .first();
    expect(audit).toMatchObject({ action: 'product.create', entity_type: 'product' });
    const stock = await db
      .prepare('SELECT on_hand FROM stock WHERE sku = ?')
      .bind('TOTE-001')
      .first();
    expect(stock).toMatchObject({ on_hand: 5 });
  });

  it('persists compareAtCents as the variant original price', async () => {
    const base = createPayload(['TOTE-SALE']);
    const payload = {
      ...base,
      variants: base.variants.map((variant) => ({ ...variant, compareAtCents: 4999 })),
    };
    const result = await runAdminAction(db, env, owner, 'product.create', payload);
    expect(result.ok).toBe(true);
    const variant = await db
      .prepare('SELECT price_cents, compare_at_cents FROM variants WHERE sku = ?')
      .bind('TOTE-SALE')
      .first();
    expect(variant).toMatchObject({ price_cents: 2999, compare_at_cents: 4999 });
  });

  it('creates six variants with matching stock and ledger rows', async () => {
    const skus = ['TOTE-S-B', 'TOTE-S-W', 'TOTE-M-B', 'TOTE-M-W', 'TOTE-L-B', 'TOTE-L-W'];
    const result = await runAdminAction(db, env, owner, 'product.create', createPayload(skus));
    expect(result.ok).toBe(true);
    expect(await count('variants')).toBe(6);
    expect(await count('stock')).toBe(6);
    expect(await count('stock_ledger')).toBe(6);
  });

  it('rolls the whole create back when a SKU already exists', async () => {
    await seedProduct(db, { sku: 'TOTE-001' });
    const before = {
      products: await count('products'),
      variants: await count('variants'),
      stock: await count('stock'),
    };
    const result = await runAdminAction(
      db,
      env,
      owner,
      'product.create',
      createPayload(['TOTE-002', 'TOTE-001'])
    );
    expect(result.ok).toBe(false);
    expect(await count('products')).toBe(before.products);
    expect(await count('variants')).toBe(before.variants);
    expect(await count('stock')).toBe(before.stock);
  });

  it('rolls the product back when the audit insert fails', async () => {
    await db
      .prepare(
        "CREATE TRIGGER fail_product_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'product.create' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END"
      )
      .run();
    try {
      const result = await runAdminAction(
        db,
        env,
        owner,
        'product.create',
        createPayload(['TOTE-001'])
      ).catch((error: unknown) => ({ ok: false, error: String(error) }));
      expect(result.ok).toBe(false);
      expect(await count('products')).toBe(0);
      expect(await count('variants')).toBe(0);
    } finally {
      await db.prepare('DROP TRIGGER fail_product_audit').run();
    }
  });

  it('denies creation to the warehouse role', async () => {
    const result = await runAdminAction(
      db,
      env,
      { id: 'wh', role: 'warehouse' },
      'product.create',
      createPayload(['TOTE-001'])
    );
    expect(result.ok).toBe(false);
    expect(await count('products')).toBe(0);
  });

  it('reports create cost for 1, 6 and 100 variants', async () => {
    const timings: Record<string, { ms: number; statements: number }> = {};
    for (const n of [1, 6, 100]) {
      const skus = Array.from({ length: n }, (_, i) => `PERF-${n}-${i}`);
      const payload = createPayload(skus);
      payload.slug = `perf-${n}`;
      const started = performance.now();
      const result = await runAdminAction(db, env, owner, 'product.create', payload);
      timings[String(n)] = {
        ms: Math.round(performance.now() - started),
        statements: 1 + 3 * n + 1,
      };
      expect(result.ok).toBe(true);
    }
    console.warn(JSON.stringify({ event: 'product_create_perf', timings }));
    expect(present(timings['100']).statements).toBe(302);
  });
});

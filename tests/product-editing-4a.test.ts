import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';

let db: D1Database, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };
const env = {} as Cloudflare.Env;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db);
});
afterEach(async () => {
  await dispose();
});

async function revision(): Promise<number> {
  const row = await db
    .prepare(
      "SELECT target_revision FROM catalog_work WHERE entity_type = 'product' AND entity_id = 'p1'"
    )
    .first<{ target_revision: number }>();
  return row?.target_revision ?? 0;
}

const update = (expectedRevision?: number, title = 'Renamed Tee') =>
  runAdminAction(db, env, owner, 'product.update', {
    productId: 'p1',
    title,
    slug: 'tee',
    description: '',
    status: 'active',
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  });

describe('Phase 4A reviewed product save', () => {
  it('saves with the opened revision and returns the accepted revision', async () => {
    const opened = await revision();
    const result = await update(opened);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { revision: number; publication: string };
      expect(data.publication).toBe('pending');
      expect(data.revision).toBeGreaterThan(opened);
    }
    const row = await db.prepare("SELECT title FROM products WHERE id = 'p1'").first();
    expect(row?.title).toBe('Renamed Tee');
  });

  it('rejects a stale revision and keeps the first save', async () => {
    const opened = await revision();
    expect((await update(opened, 'First Save')).ok).toBe(true);
    const stale = await update(opened, 'Second Save');
    expect(stale.ok).toBe(false);
    if (!stale) expect(stale.conflict).toBe(true);
    const row = await db.prepare("SELECT title FROM products WHERE id = 'p1'").first();
    expect(row?.title).toBe('First Save');
  });

  it('reports a deleted product instead of recreating it', async () => {
    const result = await runAdminAction(db, env, owner, 'product.update', {
      productId: 'deleted-product',
      title: 'Ghost',
      slug: 'ghost',
      description: '',
      status: 'draft',
      expectedRevision: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no longer exists');
    const row = await db.prepare("SELECT id FROM products WHERE id = 'deleted-product'").first();
    expect(row).toBeNull();
  });

  it('bumps product updated_at when a variant changes', async () => {
    await db
      .prepare("UPDATE products SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = 'p1'")
      .run();
    await db.prepare("UPDATE variants SET price_cents = 2500 WHERE product_id = 'p1'").run();
    const row = await db
      .prepare('SELECT updated_at FROM products WHERE id = ?')
      .bind('p1')
      .first<{ updated_at: string }>();
    expect(row?.updated_at).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('does not bump product updated_at when stock changes, so stock never dirties publication', async () => {
    await db
      .prepare("UPDATE products SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = 'p1'")
      .run();
    const beforeRevision = await revision();
    await db.prepare("UPDATE stock SET on_hand = on_hand + 3 WHERE sku = 'TEE-1'").run();
    const row = await db
      .prepare('SELECT updated_at FROM products WHERE id = ?')
      .bind('p1')
      .first<{ updated_at: string }>();
    expect(row?.updated_at).toBe('2000-01-01T00:00:00.000Z');
    expect(await revision()).toBe(beforeRevision);
  });
});

describe('product editor presentation remediation (FF-12, FF-15)', () => {
  it('labels prices in the store currency and blocks internal navigation while dirty', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('web/src/routes/admin/products/$id.tsx', 'utf8');
    expect(source).not.toContain('Price ($)');
    expect(source).not.toContain('Compare at ($)');
    expect(source).toContain('Price ({currency})');
    expect(source).toContain('useBlocker');
    expect(source).toContain("blocker.status === 'blocked'");
  });
});

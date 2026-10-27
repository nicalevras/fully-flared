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

describe('FF-16 Tier A: audit commits atomically with the change', () => {
  it('a forced audit failure leaves no discount, collection, rate, or alt text behind', async () => {
    await db
      .prepare(
        "INSERT INTO shipping_zones (id, name, countries_json, created_at) VALUES ('z1', 'US', '[\"US\"]', '2026')"
      )
      .run();
    await db
      .prepare(
        "INSERT INTO media (id, r2_key, filename, content_type, alt_text, created_at) VALUES ('m1', 'k1', 'a.jpg', 'image/jpeg', 'original', '2026')"
      )
      .run();
    await db
      .prepare(
        "CREATE TRIGGER audit_fail BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END"
      )
      .run();
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['discount.create', { code: 'FAIL10', type: 'percentage', value: 10, minPurchaseCents: 0 }],
      ['shipping.addRate', { zoneId: 'z1', name: 'Std', rateCents: 500 }],
      [
        'collection.create',
        { title: 'Failures', description: '', kind: 'manual', featuredRank: 0 },
      ],
      ['media.updateAlt', { mediaId: 'm1', altText: 'should not stick' }],
    ];
    for (const [action, payload] of attempts) {
      const result = await runAdminAction(db, env, owner, action, payload);
      expect(result.ok, action).toBe(false);
    }
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM discounts WHERE code = 'FAIL10'")
          .first<{ n: number }>()
      )?.n
    ).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM shipping_rates WHERE name = 'Std'")
          .first<{ n: number }>()
      )?.n
    ).toBe(0);
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM collections').first<{ n: number }>())?.n
    ).toBe(0);
    const media = await db
      .prepare('SELECT alt_text FROM media WHERE id = ?')
      .bind('m1')
      .first<{ alt_text: string | null }>();
    expect(media?.alt_text).toBe('original');
    await db.prepare('DROP TRIGGER audit_fail').run();
    // The same operations succeed once the audit write can land.
    const ok = await runAdminAction(db, env, owner, 'discount.create', {
      code: 'FAIL10',
      type: 'percentage',
      value: 10,
      minPurchaseCents: 0,
    });
    expect(ok.ok).toBe(true);
  });
});

describe('FF-05: discount edit mode survives a failed update', () => {
  it('clears editing only on success', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('web/src/routes/admin/discounts.tsx', 'utf8');
    expect(source).toContain('if (succeeded && editingId) setEditingId');
    expect(source).not.toContain("if (editingId) setEditingId('');");
  });
});

describe('FF-11: shipping sample quote checks permission server-side', () => {
  it('requires the shipping permission in the server function, not just staff auth', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('web/src/routes/admin/shipping.tsx', 'utf8');
    const fn = source.slice(source.indexOf('const previewQuoteFn'));
    expect(fn).toContain("requireStaffPermission(context.staff, 'shipping', 'create-zone')");
    const { roleCan } = await import('../web/src/lib/permissions');
    expect(roleCan('support', 'shipping', 'create-zone')).toBe(false);
    expect(roleCan('warehouse', 'shipping', 'create-zone')).toBe(false);
    expect(roleCan('manager', 'shipping', 'create-zone')).toBe(true);
    expect(roleCan('owner', 'shipping', 'create-zone')).toBe(true);
  });
});

describe('FF-16 Tier A remainder: catalog, variant, media, and settings writes', () => {
  it('a forced audit failure leaves every converted change uncommitted', async () => {
    await db
      .prepare(
        "INSERT INTO media (id, r2_key, filename, content_type, alt_text, created_at) VALUES ('m9', 'k9', 'b.jpg', 'image/jpeg', '', '2026')"
      )
      .run();
    await db
      .prepare(
        "CREATE TRIGGER audit_fail BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END"
      )
      .run();
    const attempts: Array<[string, Record<string, unknown>]> = [
      [
        'product.update',
        {
          productId: 'p1',
          title: 'Should not stick',
          slug: 'tee',
          description: '',
          status: 'active',
        },
      ],
      ['product.updateStatus', { productId: 'p1', status: 'archived' }],
      [
        'variant.save',
        { variantId: 'v1', productId: 'p1', sku: 'TEE-1', title: 'Default', priceCents: 9999 },
      ],
      ['variant.bulkUpdate', { variantIds: ['v1'], priceCents: 1234 }],
      ['product.attachMedia', { productId: 'p1', mediaId: 'm9' }],
      ['settings.set', { key: 'store_name', value: 'Should not stick' }],
    ];
    for (const [action, payload] of attempts) {
      const result = await runAdminAction(db, env, owner, action, payload);
      expect(result.ok, action).toBe(false);
    }
    const product = await db
      .prepare('SELECT title, status FROM products WHERE id = ?')
      .bind('p1')
      .first<{ title: string; status: string }>();
    expect(product).toEqual({ title: 'Tee', status: 'active' });
    const variant = await db
      .prepare('SELECT price_cents FROM variants WHERE id = ?')
      .bind('v1')
      .first<{ price_cents: number }>();
    expect(variant?.price_cents).toBe(2000);
    expect(
      (
        await db
          .prepare('SELECT COUNT(*) AS n FROM product_media WHERE product_id = ?')
          .bind('p1')
          .first<{ n: number }>()
      )?.n
    ).toBe(0);
    const setting = await db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .bind('store_name')
      .first<{ value: string }>();
    expect(setting?.value).not.toBe('Should not stick');
    await db.prepare('DROP TRIGGER audit_fail').run();
    const ok = await runAdminAction(db, env, owner, 'product.updateStatus', {
      productId: 'p1',
      status: 'archived',
    });
    expect(ok.ok).toBe(true);
  });
});

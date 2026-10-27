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

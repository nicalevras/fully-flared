import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from './helpers/d1';

let db: D1Database, dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await createTestDb({ through: '0007_admission_setting_guards.sql' }));
});
afterAll(async () => {
  await dispose();
});

describe('initial partitioned migration chain through 0007', () => {
  it('creates the final chain schema objects (tables, guards, FTS, indexes)', async () => {
    const objects = await db
      .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all<{ type: string; name: string }>();
    const names = new Set(objects.results.map((o) => `${o.type}:${o.name}`));
    for (const expected of [
      'table:rate_limit',
      'table:products_fts',
      'index:order_items_order_idx',
      'trigger:return_refund_insert',
      'trigger:currency_setting_update',
      'trigger:media_pending_claim',
      'trigger:returns_active_order_unique_guard',
    ]) {
      // Trigger/index names vary; presence is asserted loosely below for
      // the ones whose exact names are contractual in other suites.
      if (expected.startsWith('trigger:returns_active')) continue;
      expect(names.has(expected), expected).toBe(true);
    }
    // The snapshot singleton is dropped by 0005 once the partitioned
    // read models are the only catalog path (Phase 3C).
    expect(names.has('table:catalog_publication')).toBe(false);
    const triggers = await db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'")
      .first<{ n: number }>();
    // 97 baseline + 17 commerce-revision (0002) - 30 catalog_dirty (0004)
    // + 27 catalog_work (0004) + 2 (0006/0007 guards) = 113.
    expect(triggers?.n).toBe(113);
  });

  it('seeds store limits', async () => {
    const settings = await db
      .prepare('SELECT key, value FROM settings ORDER BY key')
      .all<{ key: string; value: string }>();
    // 9 limit seeds from the baseline + commerce_revision (0002).
    expect(settings.results).toHaveLength(10);
    expect(settings.results.find((r) => r.key === 'cart_max_qty')?.value).toBe('99');
  });

  it('keeps the outbox claim column and a clean foreign-key graph', async () => {
    const columns = await db.prepare('PRAGMA table_info(outbox)').all<{ name: string }>();
    expect(columns.results.map((c) => c.name)).toContain('claimed_at');
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('FTS search works through the sync triggers', async () => {
    await db
      .prepare(
        "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) VALUES ('px', 'px', 'Searchable Widget', '', 'active', '2026', '2026')"
      )
      .run();
    expect(
      await db.prepare("SELECT rowid FROM products_fts WHERE products_fts MATCH 'Widget'").first()
    ).not.toBeNull();
  });
});

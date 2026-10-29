import { describe, expect, it } from 'vitest';
import { applyMigrationFile, createTestDb } from './helpers/d1';

// Migration 0027 on a disposable 0026 database: stored descriptions are
// never rewritten, and the rebuilt FTS indexes visible words only.
describe('migration 0027 product description_text (disposable)', () => {
  it('backfills plain text verbatim and rich text as visible words', async () => {
    const { db, dispose } = await createTestDb({ through: '0026_brand_image_settings.sql' });
    try {
      const plain = 'Plain <b>literal</b> cotton';
      const rich =
        '<p>Soft <strong>cotton</strong> fabric</p><p><img src="/media/heroimage.png" alt="Hero"></p><p><a href="https://example.com">details</a></p>';
      await db
        .prepare(
          `INSERT INTO products (id, slug, title, description, status, created_at, updated_at)
           VALUES ('plain1', 'plain1', 'Plain Prod', ?, 'active', '2026-01-01', '2026-01-01'),
                  ('rich1', 'rich1', 'Rich Prod', ?, 'active', '2026-01-01', '2026-01-01')`
        )
        .bind(plain, rich)
        .run();
      await applyMigrationFile(db, '0027_product_description_text.sql');

      const rows = await db
        .prepare('SELECT id, description, description_text FROM products ORDER BY id')
        .all<{ id: string; description: string; description_text: string }>();
      const byId = new Map(rows.results.map((r) => [r.id, r]));
      expect(byId.get('plain1')?.description).toBe(plain);
      expect(byId.get('rich1')?.description).toBe(rich);
      expect(byId.get('plain1')?.description_text).toBe(plain);
      expect(byId.get('rich1')?.description_text).toContain('fabric');
      expect(byId.get('rich1')?.description_text).not.toContain('strong');
      expect(byId.get('rich1')?.description_text).not.toContain('heroimage');
      expect(byId.get('rich1')?.description_text).not.toContain('example.com');

      const match = async (term: string) =>
        (
          await db
            .prepare('SELECT rowid FROM products_fts WHERE products_fts MATCH ?')
            .bind(`"${term}"`)
            .all<{ rowid: number }>()
        ).results.length;
      const idsFor = async (term: string) =>
        (
          await db
            .prepare(
              'SELECT p.id FROM products_fts f JOIN products p ON p.rowid = f.rowid WHERE products_fts MATCH ?'
            )
            .bind(`"${term}"`)
            .all<{ id: string }>()
        ).results.map((r) => r.id);
      expect(await idsFor('fabric')).toEqual(['rich1']);
      expect(await idsFor('literal')).toEqual(['plain1']);
      expect(await match('strong')).toBe(0);
      expect(await match('img')).toBe(0);
      expect(await match('heroimage')).toBe(0);
    } finally {
      await dispose();
    }
  });
});

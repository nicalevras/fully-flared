import {
  Miniflare,
  convertV4MiniflareOptions,
} from '../web/node_modules/miniflare/dist/src/index.js';
import { describe, expect, it } from 'vitest';
import { applyMigrationFile, createTestDb } from './helpers/d1';

// Migration 0010 on disposable databases only (the ordinary dev DB
// application waits for separate approval): fresh install and a
// populated 0009 -> 0010 upgrade preserving publication data.
describe('migration 0010 (disposable)', () => {
  it('fresh install: execution tables and lease columns exist, FTS intact', async () => {
    const { db, dispose } = await createTestDb();
    try {
      for (const table of [
        'catalog_build_listings',
        'catalog_build_pages',
        'catalog_documents',
        'catalog_ref_documents',
      ]) {
        const row = await db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .bind(table)
          .first();
        expect(row, table).not.toBeNull();
      }
      const cols = await db
        .prepare('PRAGMA table_info(catalog_publication_state)')
        .all<{ name: string }>();
      expect(cols.results.map((c) => c.name)).toContain('lease_token');
      expect(cols.results.map((c) => c.name)).toContain('lease_fencing');
      const fts = await db
        .prepare("SELECT name FROM sqlite_master WHERE name='products_fts'")
        .first();
      expect(fts).not.toBeNull();
      const fk = await db.prepare('PRAGMA foreign_key_check').all();
      expect(fk.results.length).toBe(0);
    } finally {
      await dispose();
    }
  });

  it('populated 0009 -> 0010: publication data preserved', async () => {
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        compatibilityDate: '2025-09-06',
        d1Databases: { DB: 'migration-0010-test' },
      })
    );
    const db = await mf.getD1Database('DB');
    try {
      // Historical fixture through 0009, then 0010.
      const { readdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const files = readdirSync(join(process.cwd(), 'web', 'migrations'))
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const f of files) {
        if (f.startsWith('0010')) break;
        await applyMigrationFile(db, f);
      }
      await db
        .prepare(
          `INSERT INTO catalog_publication_state (id, publication_seq, updated_at) VALUES (1, 7, '2026-01-01')
           ON CONFLICT(id) DO UPDATE SET publication_seq=7`
        )
        .run();
      await db
        .prepare(
          `INSERT INTO catalog_ref_state (ref_key, committed_seq, delivered_seq, root_hash, updated_at)
           VALUES ('listing:all', 7, 7, 'root-hash', '2026-01-01')`
        )
        .run();
      await db
        .prepare(
          `INSERT INTO catalog_builds (id, kind, state, phase, state_json, publication_seq, created_at, updated_at)
           VALUES ('b1','full','complete','done','{}',7,'2026-01-01','2026-01-01')`
        )
        .run();
      await applyMigrationFile(db, '0010_catalog_execution.sql');
      const state = await db
        .prepare('SELECT publication_seq, lease_fencing FROM catalog_publication_state WHERE id=1')
        .first<{ publication_seq: number; lease_fencing: number }>();
      expect(state?.publication_seq).toBe(7);
      expect(state?.lease_fencing).toBe(0);
      const ref = await db
        .prepare(
          "SELECT root_hash, pending_payload FROM catalog_ref_state WHERE ref_key='listing:all'"
        )
        .first<{ root_hash: string; pending_payload: string | null }>();
      expect(ref?.root_hash).toBe('root-hash');
      expect(ref?.pending_payload).toBeNull();
      const build = await db
        .prepare("SELECT publication_seq, source_revision FROM catalog_builds WHERE id='b1'")
        .first<{ publication_seq: number; source_revision: number | null }>();
      expect(build?.publication_seq).toBe(7);
      expect(build?.source_revision).toBeNull();
      const fk = await db.prepare('PRAGMA foreign_key_check').all();
      expect(fk.results.length).toBe(0);
    } finally {
      await mf.dispose();
    }
  });
});

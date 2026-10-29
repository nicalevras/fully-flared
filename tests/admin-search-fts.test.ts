import { describe, expect, it } from 'vitest';
import { applyMigrationFile, createTestDb } from './helpers/d1';
import { ftsPhrase, ftsUsable } from '../web/src/lib/fts-search';

// Migration 0028: admin toolbar search indexes. Trigram tables keep substring
// semantics; title tables prefix-match. Sync triggers keep them current.
describe('migration 0028 admin search FTS (disposable)', () => {
  it('creates trigram + title FTS tables with sync triggers and backfill', async () => {
    const { db, dispose } = await createTestDb({ through: '0027_product_description_text.sql' });
    try {
      await db
        .prepare(
          `INSERT INTO orders (id, number, customer_email, subtotal_cents, total_cents, currency, status, payment_status, created_at, updated_at)
           VALUES ('o1', 'FF-1001', 'ada@example.com', 100, 100, 'USD', 'paid', 'paid', '2026-01-01', '2026-01-01')`
        )
        .run()
        .catch(() => undefined);
      await applyMigrationFile(db, '0028_admin_search_fts.sql');

      const tables = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('orders_fts','discounts_fts','posts_fts','pages_fts','media_fts','collections_fts') ORDER BY name"
        )
        .all<{ name: string }>();
      expect(tables.results.map((r) => r.name)).toEqual([
        'collections_fts',
        'discounts_fts',
        'media_fts',
        'orders_fts',
        'pages_fts',
        'posts_fts',
      ]);
      const triggers = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE '%_fts_a%'"
        )
        .first<{ n: number }>();
      expect(triggers?.n).toBeGreaterThanOrEqual(18);

      // backfill + trigram substring on email
      const hit = await db
        .prepare('SELECT rowid FROM orders_fts WHERE orders_fts MATCH ?')
        .bind(`customer_email : ${ftsPhrase('ada@exam')}`)
        .all<{ rowid: number }>();
      expect(hit.results.length).toBe(1);

      // trigger keeps index in sync on insert
      await db
        .prepare(
          "INSERT INTO discounts (id, code, type, value, status, created_at) VALUES ('d1', 'SUMMER10', 'percentage', 10, 'active', '2026-01-01')"
        )
        .run()
        .catch(() => undefined);
      const dHit = await db
        .prepare('SELECT rowid FROM discounts_fts WHERE discounts_fts MATCH ?')
        .bind(ftsPhrase('MMER1'))
        .all<{ rowid: number }>();
      expect(dHit.results.length).toBe(1);
      // all six admin FTS tables share the trigram (substring) rule
      const ftsSql = await db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE name IN ('orders_fts','discounts_fts','posts_fts','pages_fts','media_fts','collections_fts')"
        )
        .all<{ name: string; sql: string }>();
      for (const row of ftsSql.results) expect(row.sql, row.name).toContain('trigram');

      // substring title search: 'hoe' finds 'Running Shoes' (fails on unicode61)
      await db
        .prepare(
          "INSERT INTO posts (id, slug, title, status, created_at, updated_at) VALUES ('p1', 'running-shoes', 'Running Shoes', 'published', '2026-01-01', '2026-01-01')"
        )
        .run();
      const titleHit = await db
        .prepare('SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?')
        .bind(ftsPhrase('hoe'))
        .all<{ rowid: number }>();
      expect(titleHit.results.length).toBe(1);
    } finally {
      dispose();
    }
  });

  it('MATCH builders quote user input and gate short terms', () => {
    expect(ftsPhrase('a"b')).toBe('"a""b"');
    expect(ftsUsable('ab')).toBe(false);
    expect(ftsUsable('abc')).toBe(true);
  });
});

describe('admin toolbar search wiring', () => {
  it('all 9 list tables use the shared debounced DataTableSearch, no search <form> remains', async () => {
    const { readFileSync } = await import('node:fs');
    const routes = [
      'products/index.tsx',
      'orders/index.tsx',
      'customers.tsx',
      'articles.tsx',
      'discounts.tsx',
      'media.tsx',
      'inventory.tsx',
      'pages.tsx',
      'collections.tsx',
    ];
    for (const route of routes) {
      const src = readFileSync(`web/src/routes/admin/${route}`, 'utf8');
      expect(src, route).toContain('DataTableSearch');
      expect(src, route).not.toContain('>Search</Button>');
    }
    const shared = readFileSync('web/src/components/ui/data-table.tsx', 'utf8');
    expect(shared).toContain('export function DataTableSearch');
    expect(shared).toContain('}, 300);');
  });
});

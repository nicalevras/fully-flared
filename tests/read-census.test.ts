import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { adminInventoryList } from '../web/src/server/admin-inventory';
import { globalSearch } from '../web/src/server/admin-global-search';

// Read-path census: hot user-triggered queries must be index-served, never a
// bare table SCAN. Covering-index scans (SCAN ... USING COVERING INDEX) are
// the accepted cost of COUNT/GROUP BY totals. Plans come from the real D1
// schema (all migrations), so a dropped index or a reintroduced substring
// LIKE fallback fails here.
const HOT: Array<[string, string, unknown[]]> = [
  ['orders list', 'SELECT id FROM orders o ORDER BY o.created_at DESC, o.id DESC LIMIT 26', []],
  [
    'orders reports all-time',
    "SELECT currency,SUM(total_cents),COUNT(*) FROM orders o WHERE o.payment_status IN ('paid','refunded') GROUP BY currency",
    [],
  ],
  ['posts list', 'SELECT id FROM posts p ORDER BY p.created_at DESC LIMIT 25', []],
  ['posts count', 'SELECT COUNT(*) AS n FROM posts p', []],
  ['pages list', 'SELECT id FROM pages ORDER BY slug LIMIT 25', []],
  ['media list', 'SELECT id FROM media m ORDER BY m.created_at DESC LIMIT 25', []],
  ['discounts list', 'SELECT id FROM discounts ORDER BY created_at DESC LIMIT 25', []],
  ['collections list', 'SELECT id FROM collections ORDER BY title', []],
  ['customers list', 'SELECT id FROM user u ORDER BY u.created_at DESC LIMIT 25', []],
  [
    'inventory list',
    'SELECT p.id FROM products p ORDER BY p.title COLLATE NOCASE, p.id LIMIT 25',
    [],
  ],
  [
    'orders FTS search',
    'SELECT rowid FROM orders_fts WHERE orders_fts MATCH ?',
    ['number : "FF-1"'],
  ],
  [
    'refunds by return (admin-actions count)',
    "SELECT COUNT(*) AS n FROM refunds WHERE return_id=? AND status NOT IN ('failed','canceled')",
    ['ret1'],
  ],
  [
    'refunds webhook lookup (OR)',
    'SELECT id FROM refunds WHERE stripe_refund_id=? OR request_id=?',
    ['re_1', 'req1'],
  ],
  [
    'refunds dashboard join',
    "SELECT o.currency,SUM(r.amount_cents) FROM refunds r JOIN orders o ON o.id=r.order_id WHERE r.status='succeeded' AND r.created_at>=? AND r.created_at<? GROUP BY o.currency",
    ['2026-01-01', '2027-01-01'],
  ],
];

function isBareScan(detail: string): boolean {
  if (detail.includes('VIRTUAL TABLE') || detail.includes('(subquery')) return false;
  return /^SCAN \S+$/.test(detail.trim());
}

describe('read-path census', () => {
  it('no hot query runs a bare table scan', async () => {
    const { db, dispose } = await createTestDb();
    try {
      for (const [name, sql, binds] of HOT) {
        const rows = await db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .bind(...binds)
          .all<{ detail: string }>();
        const scans = rows.results.map((r) => r.detail).filter(isBareScan);
        expect(scans, `${name}: ${rows.results.map((r) => r.detail).join(' | ')}`).toEqual([]);
      }
    } finally {
      await dispose();
    }
  });

  it('substring LIKE fallbacks stay deleted from admin search files', () => {
    for (const file of [
      'web/src/routes/admin/articles.tsx',
      'web/src/routes/admin/pages.tsx',
      'web/src/routes/admin/media.tsx',
      'web/src/routes/admin/collections.tsx',
      'web/src/server/admin-inventory.ts',
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toContain('`%${escapeLike(');
      expect(src, file).not.toContain('`%${cq');
    }
  });

  it('short inventory queries hit SKU prefix only; title waits for 3 chars', async () => {
    const { db, dispose } = await createTestDb();
    try {
      await seedProduct(db, { onHand: 5 });
      const twoCharTitle = await adminInventoryList(db, { q: 'ee', page: 1, size: 25, low: false });
      expect(twoCharTitle.total).toBe(0);
      const skuPrefix = await adminInventoryList(db, { q: 'TE', page: 1, size: 25, low: false });
      expect(skuPrefix.total).toBeGreaterThanOrEqual(1);
      const title = await adminInventoryList(db, { q: 'Tee', page: 1, size: 25, low: false });
      expect(title.total).toBeGreaterThanOrEqual(1);
    } finally {
      await dispose();
    }
  });

  it('global search stays bounded and searches product titles only', async () => {
    const { db, dispose } = await createTestDb();
    try {
      await seedProduct(db, { onHand: 5 });
      const byTitle = await globalSearch(db, 'tee', { orders: false, customers: false });
      expect(byTitle.products.length).toBeGreaterThanOrEqual(1);
      expect(byTitle.products.length).toBeLessThanOrEqual(5);
      const byUppercaseTitle = await globalSearch(db, 'TEE', { orders: false, customers: false });
      expect(byUppercaseTitle.products).toEqual(byTitle.products);
      const bySku = await globalSearch(db, 'TEE-1', { orders: false, customers: false });
      expect(bySku.products).toEqual([]);
    } finally {
      await dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Full census: every `.prepare(` site in web/src, extracted statically,
// EXPLAINed against seeded D1, classified, and written to
// .audit/full-read-census.tsv. Dynamic SQL that cannot be EXPLAINed is
// classified MANUAL, never dropped. Bare table scans on reads are ratcheted:
// BARE_SCAN_BASELINE may only shrink; a new bare scan fails this test until
// it is classified in the audit report and the baseline is consciously moved.
const BARE_SCAN_BASELINE = 15; // audited 2026-10-29; 18 minus the 3 refunds scans closed by 0030; rest classified in .audit/d1-audit-report.md

type Site = { file: string; line: number; sql: string | null; dynamic: boolean };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function extractSites(): Site[] {
  const sites: Site[] = [];
  for (const file of walk('web/src')) {
    const src = readFileSync(file, 'utf8');
    let idx = 0;
    while ((idx = src.indexOf('.prepare(', idx)) !== -1) {
      const line = src.slice(0, idx).split('\n').length;
      let i = idx + '.prepare('.length;
      while (/\s/.test(src[i] ?? '')) i++;
      let sql: string | null = null;
      let dynamic = false;
      const quote = src[i];
      if (quote === '`' || quote === "'" || quote === '"') {
        let j = i + 1;
        let buf = '';
        while (j < src.length) {
          const ch = src[j];
          if (ch === '\\') {
            buf += src[j + 1] ?? '';
            j += 2;
            continue;
          }
          if (quote === '`' && ch === '$' && src[j + 1] === '{') {
            let depth = 1;
            let k = j + 2;
            while (k < src.length && depth > 0) {
              if (src[k] === '{') depth++;
              else if (src[k] === '}') depth--;
              k++;
            }
            buf += '?';
            dynamic = true;
            j = k;
            continue;
          }
          if (ch === quote) break;
          buf += ch;
          j++;
        }
        sql = buf.replace(/\s+/g, ' ').trim();
        if (src[j + 1] === '+' || src.slice(j + 1, j + 3).includes('+')) dynamic = true;
      }
      sites.push({ file: relative(process.cwd(), file), line, sql, dynamic });
      idx = i + 1;
    }
  }
  return sites;
}

function classify(plan: string[]): string {
  const joined = plan.join(' | ');
  if (joined.includes('VIRTUAL TABLE')) return 'SEARCH (FTS)';
  if (plan.some((d) => /^SCAN \S+$/.test(d.trim()))) return 'SCAN (bare)';
  if (joined.includes('SEARCH')) return 'SEARCH';
  if (joined.includes('USING COVERING INDEX')) return 'SCAN (covering index)';
  if (joined.includes('USING INDEX') || joined.includes('USING INTEGER PRIMARY KEY'))
    return 'SCAN (index)';
  if (joined.includes('SCAN')) return 'SCAN (other)';
  return 'OTHER';
}

describe('full read-path census (audit harness)', () => {
  it('classifies every prepare site and writes .audit/full-read-census.tsv', async () => {
    const { db, dispose } = await createTestDb();
    try {
      // Seeded scale so plans are not toy-schema artifacts (recursive CTE = 3 statements).
      await db
        .prepare(
          `INSERT INTO orders (id, number, customer_email, subtotal_cents, total_cents, payment_status, created_at, updated_at)
        WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<50000)
        SELECT 'o'||n, 'FF-'||n, 'c'||n||'@x.test', 1000, 1000, 'paid', '2026-01-01', '2026-01-01' FROM c`
        )
        .run();
      await db
        .prepare(
          `INSERT INTO products (id, slug, title, status, created_at, updated_at)
        WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<10000)
        SELECT 'sp'||n, 'p-'||n, 'Seed Product '||n, 'active', '2026-01-01', '2026-01-01' FROM c`
        )
        .run();
      await db
        .prepare(
          `INSERT INTO posts (id, slug, title, status, created_at, updated_at)
        WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<10000)
        SELECT 'sp'||n, 'post-'||n, 'Seed Post '||n, 'published', '2026-01-01', '2026-01-01' FROM c`
        )
        .run();

      // D1 rejects PRAGMA via prepare (SQLITE_AUTH, verified this run): integrity
      // checks are dashboard/`wrangler d1` territory, classified MANUAL in the report.

      const sites = extractSites();
      expect(sites.length).toBeGreaterThanOrEqual(700);
      const rows: string[] = ['file\tline\tkind\tclassification\tbounded\tsql_head\tplan'];
      let bareScans = 0;
      let classified = 0;
      for (const site of sites) {
        const head = (site.sql ?? '').slice(0, 140).replace(/\t/g, ' ');
        const keyword = (site.sql ?? '').split(' ')[0]?.toUpperCase() ?? '';
        let kind = 'MANUAL';
        let classification = 'MANUAL (no literal SQL)';
        let plan = '';
        if (site.sql && (keyword === 'SELECT' || keyword === 'WITH')) {
          kind = 'READ';
          const binds = Array((site.sql.match(/\?/g) ?? []).length).fill('1');
          try {
            const res = await db
              .prepare(`EXPLAIN QUERY PLAN ${site.sql}`)
              .bind(...binds)
              .all<{ detail: string }>();
            plan = res.results.map((r) => r.detail).join(' | ');
            classification = site.dynamic
              ? `${classify(res.results.map((r) => r.detail))} (dynamic SQL)`
              : classify(res.results.map((r) => r.detail));
            classified++;
            if (classification.startsWith('SCAN (bare)') && !/LIMIT/i.test(site.sql)) bareScans++;
          } catch {
            classification = 'MANUAL (EXPLAIN failed: dynamic SQL)';
          }
        } else if (site.sql && ['INSERT', 'UPDATE', 'DELETE'].includes(keyword)) {
          kind = 'WRITE';
          classification = 'WRITE (n/a)';
        } else if (site.sql) {
          kind = keyword || 'OTHER';
          classification = `${kind} (n/a)`;
        }
        rows.push(
          [
            site.file,
            site.line,
            kind,
            classification,
            site.sql && /LIMIT/i.test(site.sql) ? 'LIMIT' : '',
            head,
            plan.replace(/\t/g, ' '),
          ].join('\t')
        );
      }
      expect(classified).toBeGreaterThan(200);
      expect(bareScans).toBeLessThanOrEqual(BARE_SCAN_BASELINE);

      // Index inventory + redundancy flags for the write-cost audit.
      const idx = await db
        .prepare(
          "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY tbl_name, name"
        )
        .all<{ name: string; tbl_name: string; sql: string }>();
      const cols = (sql: string) =>
        (sql.match(/\((.*)\)/)?.[1] ?? '')
          .split(',')
          .map((c) =>
            c
              .trim()
              .replace(/["`[\]]/g, '')
              .toLowerCase()
          )
          .join(',');
      const inv: string[] = ['index\ttable\tcolumns\tflag'];
      for (const a of idx.results) {
        let flag = 'ok';
        for (const b of idx.results) {
          if (a === b || a.tbl_name !== b.tbl_name) continue;
          if (cols(a.sql) === cols(b.sql) && a.name > b.name) flag = `EXACT_DUP_OF ${b.name}`;
          else if (cols(b.sql).startsWith(cols(a.sql) + ','))
            flag = `PREFIX_OF ${b.name} (redundant unless it serves a distinct smaller-index need)`;
        }
        inv.push([a.name, a.tbl_name, cols(a.sql), flag].join('\t'));
      }
      mkdirSync('.audit', { recursive: true });
      writeFileSync('.audit/full-read-census.tsv', rows.join('\n') + '\n');
      writeFileSync('.audit/index-inventory.tsv', inv.join('\n') + '\n');
    } finally {
      await dispose();
    }
  }, 900_000);
});

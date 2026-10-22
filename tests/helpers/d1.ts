import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  Miniflare,
  convertV4MiniflareOptions,
} from '../../web/node_modules/miniflare/dist/src/index.js';

// Real D1 (workerd SQLite) for server-module tests: migrations are applied
// exactly as wrangler applies them, so constraints/triggers under test are
// the ones production runs.
export async function applyMigrationFile(db: D1Database, file: string): Promise<void> {
  const sql = readFileSync(join(process.cwd(), 'web', 'migrations', file), 'utf8');
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed) await db.prepare(trimmed).run();
  }
}

export async function createTestDb(
  opts: { skipFiles?: string[]; through?: string } = {}
): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'test-db',
      compatibilityDate: '2026-10-17',
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: ['DB'],
    })
  );
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const dir = join(process.cwd(), 'web', 'migrations');
  // `through` builds a historical fixture: apply migrations up to and
  // including that file (sorted names compare correctly), instead of
  // excluding individual later files and missing their dependencies.
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !opts.through || f <= opts.through)
    .filter((f) => !(opts.skipFiles ?? []).includes(f));
  for (const file of files) {
    await applyMigrationFile(db, file);
  }
  return { db, dispose: () => mf.dispose() };
}

export async function seedProduct(
  db: D1Database,
  opts: { sku?: string; priceCents?: number; onHand?: number; continueSelling?: boolean } = {}
) {
  await db
    .prepare(
      "INSERT OR IGNORE INTO shipping_zones (id, name, countries_json, created_at) VALUES ('test-zone', 'US', '[\"US\"]', '2026-01-01')"
    )
    .run();
  await db
    .prepare(
      "INSERT OR IGNORE INTO shipping_rates (id, zone_id, name, amount_cents) VALUES ('test-rate', 'test-zone', 'Free', 0)"
    )
    .run();
  const sku = opts.sku ?? 'TEE-1';
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO products (id, slug, title, description, status, created_at, updated_at)
         VALUES ('p1', 'tee', 'Tee', '', 'active', ?, ?)`
      )
      .bind(now, now),
    db
      .prepare(
        `INSERT INTO variants (id, product_id, sku, title, price_cents, status, continue_selling, created_at)
         VALUES ('v1', 'p1', ?, 'Default', ?, 'active', ?, ?)`
      )
      .bind(sku, opts.priceCents ?? 2000, opts.continueSelling ? 1 : 0, now),
    db
      .prepare('INSERT INTO stock (sku, on_hand, reserved, updated_at) VALUES (?, ?, 0, ?)')
      .bind(sku, opts.onHand ?? 5, now),
    db
      .prepare(
        `INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, created_at)
         VALUES ('seed-ledger', ?, ?, 0, 'restock', ?)`
      )
      .bind(sku, opts.onHand ?? 5, now),
  ]);
  return sku;
}

/** The ledger is the source of truth: summed deltas must equal counters. */
export async function expectLedgerMatchesCounters(db: D1Database, sku: string) {
  const counters = await db
    .prepare('SELECT on_hand, reserved FROM stock WHERE sku = ?')
    .bind(sku)
    .first<{ on_hand: number; reserved: number }>();
  const sums = await db
    .prepare(
      `SELECT COALESCE(SUM(delta_on_hand), 0) AS on_hand, COALESCE(SUM(delta_reserved), 0) AS reserved
       FROM stock_ledger WHERE sku = ?`
    )
    .bind(sku)
    .first<{ on_hand: number; reserved: number }>();
  if (!counters || !sums) throw new Error('missing stock rows');
  if (counters.on_hand !== sums.on_hand || counters.reserved !== sums.reserved) {
    throw new Error(
      `ledger/counter drift for ${sku}: counters on_hand=${counters.on_hand} reserved=${counters.reserved}, ledger on_hand=${sums.on_hand} reserved=${sums.reserved}`
    );
  }
  return counters;
}

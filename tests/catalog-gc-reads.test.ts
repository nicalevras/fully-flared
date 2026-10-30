import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { meterRowsRead } from './helpers/rows-read';
import { runCatalogGcUnit } from '../web/src/server/catalog-gc';
import {
  CATALOG_BUDGET_LIMITS,
  CatalogBudget,
  claimCatalogLease,
  countedDb,
  releaseCatalogLease,
} from '../web/src/server/catalog-exec';

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => dispose());

const checksActiveBuilds = (sql: string) => sql.includes('FROM catalog_builds WHERE state NOT IN');
// The state read joins catalog_gc_state and catalog_publication_state; the guard reads the latter.
const singletonRows = (sql: string) => (sql.includes('JOIN catalog_publication_state') ? 2 : 1);

async function insertBuilds(
  state: string,
  count: number,
  prefix: string,
  at = new Date().toISOString()
) {
  await db
    .prepare(
      `INSERT INTO catalog_builds(id,kind,state,created_at,updated_at)
    SELECT ?1||value,'capture',?2,?3,?3 FROM json_each(?4)`
    )
    .bind(prefix, state, at, JSON.stringify(Array.from({ length: count }, (_, i) => i)))
    .run();
}

it('guard reads ≤ active builds + 1 with 400 retained terminal builds', async () => {
  await insertBuilds('done', 400, 'retained-');
  const meter = meterRowsRead(db);
  const lease = await claimCatalogLease(db);
  if (!lease) throw new Error('lease not claimed');
  try {
    for (const active of [0, 2]) {
      if (active) await insertBuilds('building', active, 'live-');
      meter.reset();
      await runCatalogGcUnit(meter.db, undefined, lease);
      const checks = meter.readings(checksActiveBuilds);
      expect(checks.length).toBeGreaterThan(0);
      for (const { sql, rowsRead } of checks)
        expect(rowsRead - singletonRows(sql), sql).toBeLessThanOrEqual(active + 1);
    }
  } finally {
    await releaseCatalogLease(db, lease);
  }
});

async function count(sql: string) {
  return (await db.prepare(sql).first<{ n: number }>())?.n;
}

it('prunes up to 100 expired terminal builds per delivery within the statement budget', async () => {
  await insertBuilds('done', 250, 'expired-', '2000-01-01T00:00:00.000Z');
  await db.batch([
    db.prepare(
      "INSERT INTO catalog_build_listings(build_id,listing_id) SELECT id,'all' FROM catalog_builds"
    ),
    db.prepare(
      "INSERT INTO catalog_build_pages(build_id,listing_id,page,revision) SELECT id,'all',1,'r' FROM catalog_builds"
    ),
  ]);
  await db
    .prepare(
      "UPDATE catalog_gc_state SET phase='prune',source_revision=(SELECT gc_revision FROM catalog_publication_state WHERE id=1) WHERE id=1"
    )
    .run();
  const lease = await claimCatalogLease(db);
  if (!lease) throw new Error('lease not claimed');
  try {
    const budget = new CatalogBudget();
    expect(await runCatalogGcUnit(countedDb(db, budget), undefined, lease)).toBe(false);
    expect(budget.d1).toBeLessThanOrEqual(CATALOG_BUDGET_LIMITS.d1Statements);
    expect(await count('SELECT COUNT(*) AS n FROM catalog_builds')).toBe(150);
    expect(await count('SELECT COUNT(*) AS n FROM catalog_build_listings')).toBe(150);
    expect(await count('SELECT COUNT(*) AS n FROM catalog_build_pages')).toBe(150);
  } finally {
    await releaseCatalogLease(db, lease);
  }
});

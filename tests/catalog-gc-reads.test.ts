import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { meterRowsRead } from './helpers/rows-read';
import { runCatalogGcUnit } from '../web/src/server/catalog-gc';
import { claimCatalogLease, releaseCatalogLease } from '../web/src/server/catalog-exec';

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => dispose());

const checksActiveBuilds = (sql: string) => sql.includes('FROM catalog_builds WHERE state NOT IN');
// The state read joins catalog_gc_state and catalog_publication_state; the guard reads the latter.
const singletonRows = (sql: string) => (sql.includes('JOIN catalog_publication_state') ? 2 : 1);

async function insertBuilds(state: string, count: number, prefix: string) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO catalog_builds(id,kind,state,created_at,updated_at)
    SELECT ?1||value,'capture',?2,?3,?3 FROM json_each(?4)`
    )
    .bind(prefix, state, now, JSON.stringify(Array.from({ length: count }, (_, i) => i)))
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

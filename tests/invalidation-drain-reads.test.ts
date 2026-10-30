import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';
import { meterRowsRead } from './helpers/rows-read';
import { drainCatalogInvalidations } from '../web/src/server/public-cache';

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => dispose());

it('a 100-tag chunk with 1,000 pending reads ≤ 500', async () => {
  await db
    .prepare(
      "INSERT INTO catalog_invalidations(id,scope,scope_id,created_at) SELECT 'i'||value,'product','p'||value,'2026-01-01' FROM json_each(?)"
    )
    .bind(JSON.stringify(Array.from({ length: 1_000 }, (_, i) => i)))
    .run();
  const meter = meterRowsRead(db);
  const purge = vi.fn(async () => ({}));
  const result = await drainCatalogInvalidations(meter.db, purge, 100);
  expect(purge).toHaveBeenCalledTimes(1);
  expect(result.drained).toBe(100);
  expect(
    (await db.prepare('SELECT COUNT(*) AS n FROM catalog_invalidations').first<{ n: number }>())?.n
  ).toBe(900);
  expect(
    meter.rowsRead((sql) => sql.startsWith('DELETE FROM catalog_invalidations'))
  ).toBeLessThanOrEqual(500);
});

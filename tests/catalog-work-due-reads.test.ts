import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { meterRowsRead } from './helpers/rows-read';
import { catalogWorkDue } from '../web/src/server/catalog-operations';

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => dispose());

async function insertWork(
  prefix: string,
  count: number,
  processed: number,
  nextAttemptAt: string | null
) {
  await db
    .prepare(
      "INSERT INTO catalog_work(id,entity_type,entity_id,target_revision,processed_revision,next_attempt_at,created_at,updated_at) SELECT 'product:'||?1||value,'product',?1||value,1,?2,?3,'2026-01-01','2026-01-01' FROM json_each(?4)"
    )
    .bind(
      prefix,
      processed,
      nextAttemptAt,
      JSON.stringify(Array.from({ length: count }, (_, i) => i))
    )
    .run();
}

it('reads ≤ pending + 1 with 1,600 processed rows', async () => {
  await db
    .prepare(
      "INSERT INTO catalog_listings(listing_id,generation,page_size,page_count,total,active,updated_at) VALUES('all',1,24,0,0,1,'2000')"
    )
    .run();
  await db.prepare('UPDATE catalog_work SET processed_revision=target_revision').run();
  const meter = meterRowsRead(db);
  expect(await catalogWorkDue(meter.db)).toBe(false);
  const baseline = meter.rowsRead();
  meter.reset();

  const pending = 5;
  await insertWork('done-', 1_600, 1, null);
  await insertWork('later-', pending, 0, '2999-01-01T00:00:00.000Z');
  expect(await catalogWorkDue(meter.db)).toBe(false);
  expect(meter.rowsRead() - baseline).toBeLessThanOrEqual(pending + 1);
});

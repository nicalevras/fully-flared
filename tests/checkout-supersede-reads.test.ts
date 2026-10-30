import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { meterRowsRead } from './helpers/rows-read';
import { supersededIntentIds } from '../web/src/server/checkout-intents';

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => dispose());

async function retainIntents(count: number, supersededBy: (i: number) => string | null) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `intent-${i}`,
    at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    supersededBy: supersededBy(i),
  }));
  await db.batch([
    db
      .prepare(
        `INSERT INTO orders(id,number,status,payment_status,customer_email,currency,subtotal_cents,total_cents,created_at,updated_at)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.id'),'canceled','unpaid','fixture@example.invalid','USD',0,0,json_extract(value,'$.at'),json_extract(value,'$.at') FROM json_each(?)`
      )
      .bind(JSON.stringify(rows)),
    db
      .prepare(
        `INSERT INTO checkout_intents(id,order_id,owner_type,fingerprint,provider_payload_json,coupon_idempotency_key,session_idempotency_key,session_expires_at,superseded_by,created_at,updated_at)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.id'),'guest',json_extract(value,'$.id'),'{}',json_extract(value,'$.id'),json_extract(value,'$.id'),json_extract(value,'$.at'),json_extract(value,'$.supersededBy'),json_extract(value,'$.at'),json_extract(value,'$.at') FROM json_each(?)`
      )
      .bind(JSON.stringify(rows)),
  ]);
}

it('POST supersede lookup reads ≤ 21 rows with 5,000 retained intents', async () => {
  await retainIntents(5_000, (i) =>
    i >= 4_970 ? 'intent-4999' : i % 2 ? `intent-${i - 1}` : null
  );
  const meter = meterRowsRead(db);
  const ids = await supersededIntentIds(meter.db, 'intent-4999');
  expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => `intent-${4_970 + i}`));
  expect(meter.rowsRead()).toBeLessThanOrEqual(21);
});

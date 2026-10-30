import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';
import { calculateShipping } from '../web/src/server/checkout';

let db: D1Database, env: Env, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };

beforeEach(async () => {
  ({ db, env, dispose } = await createTestDb());
  await db
    .prepare(
      "INSERT INTO shipping_zones (id, name, countries_json, created_at) VALUES ('z1', 'United States', '[\"US\"]', '2026-01-01T00:00:00.000Z')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO shipping_rates (id, zone_id, name, kind, amount_cents, free_over_cents, per_kg_cents) VALUES ('r1', 'z1', 'Standard', 'flat', 500, NULL, NULL)"
    )
    .run();
});
afterEach(async () => {
  await dispose();
});

describe('Phase 15 shipping', () => {
  it('quotes through the same calculation checkout uses', async () => {
    await expect(calculateShipping(db, 'r1', 2000, 1000, 'US')).resolves.toBe(500);
    await expect(calculateShipping(db, 'r1', 2000, 1000, 'CA')).rejects.toThrow(/country/);
  });

  it('deletes a rate and checkout can no longer use it', async () => {
    const result = await runAdminAction(db, env, owner, 'shipping.deleteRate', { rateId: 'r1' });
    expect(result.ok).toBe(true);
    await expect(calculateShipping(db, 'r1', 2000, 1000, 'US')).rejects.toThrow(/Unknown/);
  });

  it('reports a missing rate instead of deleting nothing silently', async () => {
    const result = await runAdminAction(db, env, owner, 'shipping.deleteRate', {
      rateId: 'missing',
    });
    expect(result.ok).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';

let db: D1Database, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };
const env = {} as Cloudflare.Env;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => {
  await dispose();
});

const csv = [
  'title,slug,sku,price_cents,stock',
  'Alpha,alpha,ALPHA-1,1000,5',
  'Broken,broken,BROKEN-1,not-a-price,5',
  'Beta,beta,BETA-1,2000,2',
].join('\n');

describe('Phase 5B CSV import behavior', () => {
  it('imports good rows and reports bad rows by number', async () => {
    const result = await runAdminAction(db, env, owner, 'import.productsCsv', { csv });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { imported: number; errors: Array<{ row: number }> };
      expect(data.imported).toBe(2);
      expect(data.errors.map((entry) => entry.row)).toEqual([3]);
    }
    const count = await db.prepare('SELECT COUNT(*) AS n FROM products').first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('re-running the same import does not duplicate products', async () => {
    expect((await runAdminAction(db, env, owner, 'import.productsCsv', { csv })).ok).toBe(true);
    const second = await runAdminAction(db, env, owner, 'import.productsCsv', { csv });
    expect(second.ok).toBe(true);
    if (second.ok) {
      const data = second.data as { imported: number; errors: unknown[] };
      expect(data.imported).toBe(0);
      expect(data.errors.length).toBe(3);
    }
    const count = await db.prepare('SELECT COUNT(*) AS n FROM products').first<{ n: number }>();
    expect(count?.n).toBe(2);
  });
});

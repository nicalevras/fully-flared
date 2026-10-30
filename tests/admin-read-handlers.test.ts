import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { adminDiscounts } from '../web/src/server/admin-lists';
import { adminInventoryDetail } from '../web/src/server/admin-inventory';

let db: D1Database, dispose: () => Promise<void>;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 5 });
});
afterEach(() => dispose());

const forbidden = { name: 'AuthError', code: 'FORBIDDEN' };

describe('admin read handlers check the caller role (MS-4, R-05)', () => {
  it('support cannot list discounts; a manager can', async () => {
    const page = { q: '', page: 1, size: 25 } as const;
    await expect(adminDiscounts(db, { role: 'support' }, page)).rejects.toMatchObject(forbidden);
    await expect(adminDiscounts(db, { role: 'manager' }, page)).resolves.toMatchObject({
      total: 0,
    });
  });

  it('a role without stock view cannot read a SKU; support can', async () => {
    await expect(adminInventoryDetail(db, { role: 'customer' }, 'TEE-1')).rejects.toMatchObject(
      forbidden
    );
    await expect(adminInventoryDetail(db, { role: 'support' }, 'TEE-1')).resolves.toMatchObject({
      sku: 'TEE-1',
      onHand: 5,
      available: 5,
    });
  });
});

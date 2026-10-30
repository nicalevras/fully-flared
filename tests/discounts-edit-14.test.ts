import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';

let db: D1Database, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };
const env = {} as Cloudflare.Env;
let firstId = '';
let secondId = '';

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  const first = await runAdminAction(db, env, owner, 'discount.create', {
    code: 'FIRST10',
    type: 'percentage',
    value: 10,
  });
  const second = await runAdminAction(db, env, owner, 'discount.create', {
    code: 'SECOND20',
    type: 'percentage',
    value: 20,
  });
  if (first.ok) firstId = (first.data as { discountId: string }).discountId;
  if (second.ok) secondId = (second.data as { discountId: string }).discountId;
});
afterEach(async () => {
  await dispose();
});

describe('Phase 14 discount editing', () => {
  it('updates limits and expiry without touching usage', async () => {
    const result = await runAdminAction(db, env, owner, 'discount.update', {
      discountId: firstId,
      code: 'FIRST15',
      type: 'percentage',
      value: 15,
      minPurchaseCents: 5000,
      usageLimit: 3,
      expiresAt: '2030-01-01T04:59:00.000Z',
    });
    expect(result.ok).toBe(true);
    const row = await db
      .prepare(
        'SELECT code, value, min_purchase_cents, usage_limit, expires_at FROM discounts WHERE id = ?'
      )
      .bind(firstId)
      .first<{
        code: string;
        value: number;
        min_purchase_cents: number;
        usage_limit: number;
        expires_at: string;
      }>();
    expect(row).toEqual({
      code: 'FIRST15',
      value: 15,
      min_purchase_cents: 5000,
      usage_limit: 3,
      expires_at: '2030-01-01T04:59:00.000Z',
    });
  });

  it('rejects a code that belongs to another discount', async () => {
    const result = await runAdminAction(db, env, owner, 'discount.update', {
      discountId: firstId,
      code: 'second20',
      type: 'percentage',
      value: 15,
    });
    expect(result.ok).toBe(false);
    expect(secondId).toBeTruthy();
  });
});

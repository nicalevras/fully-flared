import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';
import { calculateDiscount } from '../web/src/server/checkout';

let db: D1Database, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };
const env = {};

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => {
  await dispose();
});

const discountId = async (code: string) =>
  (await db.prepare('SELECT id FROM discounts WHERE code = ?').bind(code).first<{ id: string }>())
    ?.id ?? '';

async function useOnce(id: string, orderId: string) {
  await db
    .prepare(
      "INSERT INTO discount_usage (id, discount_id, order_id, customer_email, amount_cents, created_at) VALUES (?, ?, ?, 'buyer@example.com', 100, '2026-10-30T00:00:00.000Z')"
    )
    .bind(`use-${orderId}`, id, orderId)
    .run();
}

it('create stores usage_per_customer=3 and checkout allows 3', async () => {
  const created = await runAdminAction(db, env, owner, 'discount.create', {
    code: 'THRICE',
    type: 'percentage',
    value: 10,
    usagePerCustomer: 3,
  });
  expect(created.ok).toBe(true);
  const id = await discountId('THRICE');
  for (const order of ['o1', 'o2']) await useOnce(id, order);
  expect(await calculateDiscount(db, 'THRICE', 2000, 'buyer@example.com')).not.toBeNull();
  await useOnce(id, 'o3');
  expect(await calculateDiscount(db, 'THRICE', 2000, 'buyer@example.com')).toBeNull();
});

it('create and update store the discount cap and start time', async () => {
  const created = await runAdminAction(db, env, owner, 'discount.create', {
    code: 'CAPPED',
    type: 'percentage',
    value: 50,
    maxDiscountCents: 500,
  });
  expect(created.ok).toBe(true);
  expect(await calculateDiscount(db, 'CAPPED', 4000, null)).toEqual(
    expect.objectContaining({ amountCents: 500 })
  );
  const id = await discountId('CAPPED');
  const updated = await runAdminAction(db, env, owner, 'discount.update', {
    discountId: id,
    code: 'CAPPED',
    type: 'percentage',
    value: 50,
    maxDiscountCents: null,
    usagePerCustomer: 2,
    startsAt: '2099-01-01T00:00:00.000Z',
  });
  expect(updated.ok).toBe(true);
  expect(
    await db
      .prepare(
        'SELECT max_discount_cents, usage_per_customer, starts_at FROM discounts WHERE id = ?'
      )
      .bind(id)
      .first()
  ).toEqual({
    max_discount_cents: null,
    usage_per_customer: 2,
    starts_at: '2099-01-01T00:00:00.000Z',
  });
});

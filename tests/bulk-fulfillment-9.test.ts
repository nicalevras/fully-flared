import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';
import {
  applyBulkOutcome,
  bulkTrackingErrors,
  createBulkItems,
  retryableBulkItems,
  summarizeBulk,
} from '../web/src/lib/bulk-fulfillment';

describe('Phase 9 bulk fulfillment state', () => {
  it('caps the batch, requires tracking, and retries only failures', () => {
    const tooMany = createBulkItems(
      Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, number: `FF-${i}` }))
    );
    expect(tooMany.error).toContain('at most 10');
    const { items } = createBulkItems([
      { id: 'o1', number: 'FF-1' },
      { id: 'o2', number: 'FF-2' },
    ]);
    expect(bulkTrackingErrors(items)).toHaveLength(2);
    let next = applyBulkOutcome(
      items.map((i) => ({ ...i, tracking: 'TRK' })),
      'o1',
      { ok: true, message: 'Shipped' }
    );
    next = applyBulkOutcome(next, 'o2', { ok: false, message: 'Not eligible' });
    expect(summarizeBulk(next).partial).toBe(true);
    expect(retryableBulkItems(next).map((i) => i.orderId)).toEqual(['o2']);
  });
});

let db: D1Database, env: Env, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };

async function insertOrder(id: string, number: string, status: string) {
  await db
    .prepare(
      `INSERT INTO orders (id, number, status, payment_status, customer_email, currency, subtotal_cents, total_cents, created_at, updated_at)
       VALUES (?, ?, ?, 'paid', 'buyer@example.com', 'USD', 1000, 1000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    )
    .bind(id, number, status)
    .run();
}

beforeEach(async () => {
  ({ db, env, dispose } = await createTestDb());
  await insertOrder('o1', 'FF-1', 'paid');
  await insertOrder('o2', 'FF-2', 'paid');
  await insertOrder('o3', 'FF-3', 'shipped');
});
afterEach(async () => {
  await dispose();
});

describe('Phase 9 bulk shipment server outcomes', () => {
  it('ships eligible orders once and a repeated ship creates no second shipment email', async () => {
    const ship = (orderId: string) =>
      runAdminAction(db, env, owner, 'order.ship', {
        orderId,
        trackingNumber: 'TRK-1',
      });
    expect((await ship('o1')).ok).toBe(true);
    expect((await ship('o2')).ok).toBe(true);
    expect((await ship('o3')).ok).toBe(false);
    const repeat = await ship('o1');
    expect(repeat.ok).toBe(false);
    const emails = await db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE id LIKE 'shipment-%'")
      .first<{ n: number }>();
    expect(emails?.n).toBe(2);
  });

  it('records eight successes and two failures out of ten, and retrying the two adds no shipment email', async () => {
    for (let i = 4; i <= 10; i++) {
      await insertOrder(`o${i}`, `FF-${i}`, i <= 9 ? 'paid' : 'shipped');
    }
    await insertOrder('o11', 'FF-11', 'paid');
    const ids = ['o1', 'o2', 'o4', 'o5', 'o6', 'o7', 'o8', 'o11', 'o3', 'o10'];
    const ship = (orderId: string) =>
      runAdminAction(db, env, owner, 'order.ship', {
        orderId,
        trackingNumber: 'TRK-9',
      });
    const outcomes = [];
    for (const orderId of ids) outcomes.push((await ship(orderId)).ok);
    expect(outcomes.filter(Boolean)).toHaveLength(8);
    for (const orderId of ['o3', 'o10']) expect((await ship(orderId)).ok).toBe(false);
    const emails = await db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE id LIKE 'shipment-%'")
      .first<{ n: number }>();
    expect(emails?.n).toBe(8);
  });
});

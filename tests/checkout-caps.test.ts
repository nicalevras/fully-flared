import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { cancelOrderById, createPendingOrder } from '../web/src/server/checkout';

let db: D1Database;
let dispose: () => Promise<void>;
const created: string[] = [];

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  await seedProduct(db, { onHand: 100 });
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('user-cap', 'Cap', 'cap@example.com', 1, ?, ?)"
    )
    .bind(now, now)
    .run();
});
afterAll(async () => {
  for (const id of created) await cancelOrderById(db, id).catch(() => undefined);
  await dispose();
});

describe('active-hold caps (C13)', () => {
  it('caps live holds per signed-in account even across rotating emails', async () => {
    for (let i = 0; i < 5; i++) {
      const o = await createPendingOrder(db, {
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        email: `rot${i}@example.com`,
        userId: 'user-cap',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      });
      created.push(o.orderId);
    }
    await expect(
      createPendingOrder(db, {
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        email: 'rot5@example.com',
        userId: 'user-cap',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      })
    ).rejects.toThrow(/Too many open checkouts/);
  });

  it('caps live holds per client IP even across rotating emails and guests', async () => {
    for (let i = 0; i < 10; i++) {
      const o = await createPendingOrder(db, {
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        email: `ip${i}@example.com`,
        ip: '203.0.113.7',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      });
      created.push(o.orderId);
    }
    await expect(
      createPendingOrder(db, {
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        email: 'ip10@example.com',
        ip: '203.0.113.7',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      })
    ).rejects.toThrow(/Too many open checkouts/);
    // A different IP is unaffected.
    const ok = await createPendingOrder(db, {
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      email: 'other@example.com',
      ip: '203.0.113.8',
      lines: [{ sku: 'TEE-1', qty: 1 }],
    });
    created.push(ok.orderId);
  });
});

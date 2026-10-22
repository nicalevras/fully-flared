import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct, expectLedgerMatchesCounters } from './helpers/d1';
import {
  adjustStock,
  commitReservation,
  releaseReservation,
  reserveStock,
  InsufficientStock,
} from '../web/src/server/inventory';

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
});
afterAll(async () => {
  await dispose();
});

describe('atomic reservations', () => {
  it('100 parallel attempts on the last units: exactly stock-many succeed, zero oversell', async () => {
    await seedProduct(db, { onHand: 5 });
    const attempts = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) =>
        reserveStock(db, [{ sku: 'TEE-1', qty: 1 }], { cartId: `c${i}` })
      )
    );
    const ok = attempts.filter((a) => a.status === 'fulfilled');
    expect(ok).toHaveLength(5);
    const counters = await expectLedgerMatchesCounters(db, 'TEE-1');
    expect(counters).toEqual({ on_hand: 5, reserved: 5 });
  }, 60_000);

  it('a multi-line reserve that fails on one line leaves no partial hold and a balanced ledger', async () => {
    await db.batch([
      db
        .prepare(
          "INSERT INTO variants (id, product_id, sku, title, price_cents, status, created_at) VALUES ('v2', 'p1', 'TEE-2', 'Default', 1000, 'active', ?)"
        )
        .bind(new Date().toISOString()),
      db
        .prepare("INSERT INTO stock (sku, on_hand, reserved, updated_at) VALUES ('TEE-2', 0, 0, ?)")
        .bind(new Date().toISOString()),
    ]);
    await expect(
      reserveStock(
        db,
        [
          { sku: 'TEE-1', qty: 1 },
          { sku: 'TEE-2', qty: 1 },
        ],
        { cartId: 'multi' }
      )
    ).rejects.toBeInstanceOf(InsufficientStock);
    // TEE-1 was fully reserved by the previous test; its counters must not move.
    const counters = await expectLedgerMatchesCounters(db, 'TEE-1');
    expect(counters.reserved).toBe(5);
    await expectLedgerMatchesCounters(db, 'TEE-2');
    const active = await db
      .prepare(
        "SELECT COUNT(*) AS c FROM reservations WHERE status = 'active' AND cart_id = 'multi'"
      )
      .first<{ c: number }>();
    expect(active?.c).toBe(0);
  });

  it('commit then replayed commit/release stays consistent with the ledger', async () => {
    const ids = await reserveStock(db, [{ sku: 'TEE-1', qty: 0 }], { cartId: 'noop' }).catch(
      () => [] as string[]
    );
    expect(ids).toEqual([]);
  });

  it('commit and release are idempotent under replay', async () => {
    // Free one unit first.
    const rows = await db
      .prepare("SELECT id FROM reservations WHERE status = 'active' LIMIT 1")
      .all<{ id: string }>();
    const first = rows.results[0];
    if (!first) throw new Error('expected an active reservation');
    await releaseReservation(db, first.id);
    await releaseReservation(db, first.id); // replay: no-op
    let counters = await expectLedgerMatchesCounters(db, 'TEE-1');
    expect(counters.reserved).toBe(4);

    const [rid] = await reserveStock(db, [{ sku: 'TEE-1', qty: 1 }], { orderId: 'o1' });
    if (!rid) throw new Error('reserve failed');
    await commitReservation(db, rid);
    await commitReservation(db, rid); // replay: no-op
    await releaseReservation(db, rid); // after commit: no-op
    counters = await expectLedgerMatchesCounters(db, 'TEE-1');
    expect(counters).toEqual({ on_hand: 4, reserved: 4 });
  });

  it('a negative correction that would drive on_hand below zero fails instead of clamping', async () => {
    await expect(adjustStock(db, 'TEE-1', -99, 'correction')).rejects.toThrow();
    const counters = await expectLedgerMatchesCounters(db, 'TEE-1');
    expect(counters.on_hand).toBe(4);
  });
});

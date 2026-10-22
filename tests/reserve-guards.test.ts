import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct, expectLedgerMatchesCounters } from './helpers/d1';
import {
  adjustStock,
  commitReservation,
  releaseReservation,
  reserveStock,
} from '../web/src/server/inventory';

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  await seedProduct(db, { sku: 'TEE-1', onHand: 20 });
  await seedProduct(db, { sku: 'TEE-2', onHand: 15 }).catch(async () => {
    // seedProduct hardcodes product/variant ids; insert the second SKU manually.
    const now = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          "INSERT INTO variants (id, product_id, sku, title, price_cents, status, continue_selling, created_at) VALUES ('v2', 'p1', 'TEE-2', 'Default', 2000, 'active', 0, ?)"
        )
        .bind(now),
      db
        .prepare(
          "INSERT INTO stock (sku, on_hand, reserved, updated_at) VALUES ('TEE-2', 15, 0, ?)"
        )
        .bind(now),
      db
        .prepare(
          "INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, created_at) VALUES ('led-tee2', 'TEE-2', 15, 0, 'restock', ?)"
        )
        .bind(now),
    ]);
  });
});
afterAll(async () => {
  await dispose();
});

describe('database-level reserve guards (B9)', () => {
  it('rejects a reservation with qty <= 0 at the database, not just in code', async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO reservations (id, sku, qty, status, expires_at, created_at) VALUES ('bad-qty', 'TEE-1', 0, 'active', ?, ?)"
        )
        .bind(new Date().toISOString(), new Date().toISOString())
        .run()
    ).rejects.toThrow();
  });

  it('rejects reserved > on_hand at the database for non-backorder variants', async () => {
    await expect(
      db.prepare("UPDATE stock SET reserved = on_hand + 1 WHERE sku = 'TEE-1'").run()
    ).rejects.toThrow();
    const row = await db
      .prepare('SELECT reserved FROM stock WHERE sku = ?')
      .bind('TEE-1')
      .first<{ reserved: number }>();
    expect(row?.reserved).toBe(0);
  });

  it(
    'randomized reserve/commit/release/adjust mix never oversells and the ledger always reconciles',
    { timeout: 60_000 },
    async () => {
      // Deterministic PRNG (mulberry32) so failures reproduce exactly.
      let state = 42;
      const rand = () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let x = Math.imul(state ^ (state >>> 15), 1 | state);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
      const skus = ['TEE-1', 'TEE-2'];
      const active = new Map<string, { id: string; sku: string }>();
      for (let step = 0; step < 200; step++) {
        const sku = skus[Math.floor(rand() * skus.length)]!;
        const op = rand();
        try {
          if (op < 0.4) {
            const ids = await reserveStock(db, [{ sku, qty: 1 + Math.floor(rand() * 3) }], {
              cartId: `r-${step}`,
            });
            for (const id of ids) active.set(id, { id, sku });
          } else if (op < 0.6 && active.size > 0) {
            const [first] = active.values();
            if (first) {
              await commitReservation(db, first.id);
              active.delete(first.id);
            }
          } else if (op < 0.8 && active.size > 0) {
            const [first] = active.values();
            if (first) {
              await releaseReservation(db, first.id);
              active.delete(first.id);
            }
          } else {
            // Import/adjustment path (same function CSV import uses).
            await adjustStock(db, sku, rand() > 0.5 ? 2 : -1, 'correction');
          }
        } catch {
          // InsufficientStock and guard aborts are legal outcomes; the
          // invariants below are what must hold after every single step.
        }
        const counters = await expectLedgerMatchesCounters(db, sku);
        expect(counters.on_hand).toBeGreaterThanOrEqual(0);
        expect(counters.reserved).toBeGreaterThanOrEqual(0);
        expect(counters.reserved).toBeLessThanOrEqual(counters.on_hand);
      }
    }
  );
});

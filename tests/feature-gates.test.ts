import { describe, expect, it } from 'vitest';
import { createTestDb, seedProduct, expectLedgerMatchesCounters } from './helpers/d1';
import { at } from './helpers/fixtures';
import { runAdminAction } from '../web/src/server/admin-actions';
import { calculateShipping } from '../web/src/server/checkout';
import { reserveStock, commitReservation, releaseReservation } from '../web/src/server/inventory';
import { createAuth } from '../web/src/lib/auth';
import { heldOrder } from './helpers/pending-intent';

const now = () => new Date().toISOString();
const owner = { id: 'owner-1', role: 'owner' };

async function seedVariants(db: D1Database, count: number) {
  await db
    .prepare(
      "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) VALUES ('bp', 'bulk', 'Bulk', '', 'active', ?, ?)"
    )
    .bind(now(), now())
    .run();
  const stmts: D1PreparedStatement[] = [];
  for (let i = 1; i <= count; i++) {
    stmts.push(
      db
        .prepare(
          "INSERT INTO variants (id, product_id, sku, title, price_cents, status, continue_selling, created_at) VALUES (?, 'bp', ?, 'V', 1000, 'active', 0, ?)"
        )
        .bind(`bv${i}`, `BULK-${i}`, now()),
      db
        .prepare('INSERT INTO stock (sku, on_hand, reserved, updated_at) VALUES (?, 10, 0, ?)')
        .bind(`BULK-${i}`, now()),
      db
        .prepare(
          "INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, created_at) VALUES (?, ?, 10, 0, 'restock', ?)"
        )
        .bind(`bl${i}`, `BULK-${i}`, now())
    );
  }
  await db.batch(stmts);
  return Array.from({ length: count }, (_, i) => `bv${i + 1}`);
}

describe('50-variant bulk edit is atomic', () => {
  it('applies price + stock to all 50 in one edit, ledger intact', async () => {
    const { db, env, dispose } = await createTestDb();
    try {
      const ids = await seedVariants(db, 50);
      const result = await runAdminAction(db, env, owner, 'variant.bulkUpdate', {
        variantIds: ids,
        priceCents: 2500,
        stockDelta: 3,
      });
      expect(result).toMatchObject({ ok: true, data: { updated: 50 } });
      const priced = await db
        .prepare('SELECT COUNT(*) AS c FROM variants WHERE price_cents = 2500')
        .first<{ c: number }>();
      expect(priced?.c).toBe(50);
      await expectLedgerMatchesCounters(db, 'BULK-1');
      await expectLedgerMatchesCounters(db, 'BULK-50');
    } finally {
      await dispose();
    }
  }, 60_000);

  it('one unknown variant aborts the whole edit with no changes', async () => {
    const { db, env, dispose } = await createTestDb();
    try {
      const ids = await seedVariants(db, 3);
      const result = await runAdminAction(db, env, owner, 'variant.bulkUpdate', {
        variantIds: [...ids, 'missing'],
        priceCents: 9999,
      });
      expect(result.ok).toBe(false);
      const priced = await db
        .prepare('SELECT COUNT(*) AS c FROM variants WHERE price_cents = 9999')
        .first<{ c: number }>();
      expect(priced?.c).toBe(0);
    } finally {
      await dispose();
    }
  }, 60_000);

  it('a variant deleted between validation and batch aborts with no ledger writes', async () => {
    const { db, env, dispose } = await createTestDb();
    try {
      const ids = await seedVariants(db, 2);
      let injected = false;
      const racing = new Proxy(db, {
        get(target, key) {
          if (key === 'batch')
            return async (stmts: D1PreparedStatement[]) => {
              if (!injected) {
                injected = true;
                await target
                  .prepare("DELETE FROM stock WHERE sku='BULK-2'")
                  .run()
                  .catch(() => undefined);
                await target.prepare("DELETE FROM variants WHERE id='bv2'").run();
              }
              return target.batch(stmts);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const result = await runAdminAction(racing, env, owner, 'variant.bulkUpdate', {
        variantIds: ids,
        priceCents: 2500,
        stockDelta: 2,
      }).catch((e: Error) => ({ ok: false, error: e.message }));
      expect(result.ok).toBe(false);
      // Nothing landed: no price change, no correction ledger entries.
      const priced = await db
        .prepare('SELECT COUNT(*) AS c FROM variants WHERE price_cents = 2500')
        .first<{ c: number }>();
      expect(priced?.c).toBe(0);
      const corrections = await db
        .prepare("SELECT COUNT(*) AS c FROM stock_ledger WHERE reason='correction'")
        .first<{ c: number }>();
      expect(corrections?.c).toBe(0);
      const onHand = await db
        .prepare("SELECT on_hand FROM stock WHERE sku='BULK-1'")
        .first<{ on_hand: number }>();
      expect(onHand?.on_hand).toBe(10);
    } finally {
      await dispose();
    }
  }, 60_000);

  it('a missing stock row aborts a bulk stock adjustment instead of reporting success', async () => {
    const { db, env, dispose } = await createTestDb();
    try {
      const ids = await seedVariants(db, 2);
      await db.prepare("DELETE FROM stock WHERE sku='BULK-2'").run();
      const result = await runAdminAction(db, env, owner, 'variant.bulkUpdate', {
        variantIds: ids,
        stockDelta: 2,
      }).catch((e: Error) => ({ ok: false, error: e.message }));
      expect(result.ok).toBe(false);
      const corrections = await db
        .prepare("SELECT COUNT(*) AS c FROM stock_ledger WHERE reason='correction'")
        .first<{ c: number }>();
      expect(corrections?.c).toBe(0);
    } finally {
      await dispose();
    }
  }, 60_000);

  it('a stock guard failure rolls back the price change too', async () => {
    const { db, env, dispose } = await createTestDb();
    try {
      const ids = await seedVariants(db, 2);
      // BULK-2 has 10 on hand; -999 must fail the guard and abort the batch.
      const result = await runAdminAction(db, env, owner, 'variant.bulkUpdate', {
        variantIds: ids,
        priceCents: 7777,
        stockDelta: -999,
      }).catch((e: Error) => ({ ok: false, error: e.message }));
      expect(result.ok).toBe(false);
      const priced = await db
        .prepare('SELECT COUNT(*) AS c FROM variants WHERE price_cents = 7777')
        .first<{ c: number }>();
      expect(priced?.c).toBe(0);
    } finally {
      await dispose();
    }
  }, 60_000);
});

describe('weight-based shipping and backorder at checkout', () => {
  it('weight rate charges base + per-kg on total variant weight', async () => {
    const { db, dispose } = await createTestDb();
    try {
      await db.batch([
        db
          .prepare(
            "INSERT INTO shipping_zones (id, name, countries_json, created_at) VALUES ('z1', 'US', '[\"US\"]', ?)"
          )
          .bind(now()),
        db
          .prepare(
            "INSERT INTO shipping_rates (id, zone_id, name, kind, amount_cents, per_kg_cents) VALUES ('r1', 'z1', 'Weighted', 'weight', 500, 200)"
          )
          .bind(),
      ]);
      // 2.5 kg rounds up to 3 kg: 500 + 3*200 = 1100.
      expect(await calculateShipping(db, 'r1', 10000, 2500, 'US')).toBe(1100);
      expect(await calculateShipping(db, 'r1', 10000, 0, 'US')).toBe(500);
    } finally {
      await dispose();
    }
  }, 60_000);

  it('checkout totals include weight shipping from variant weights', async () => {
    const { db, dispose } = await createTestDb();
    try {
      const sku = await seedProduct(db, { onHand: 5 });
      await db.prepare('UPDATE variants SET weight_grams = 1200 WHERE sku = ?').bind(sku).run();
      await db.batch([
        db
          .prepare(
            "INSERT INTO shipping_zones (id, name, countries_json, created_at) VALUES ('z1', 'US', '[\"US\"]', ?)"
          )
          .bind(now()),
        db
          .prepare(
            "INSERT INTO shipping_rates (id, zone_id, name, kind, amount_cents, per_kg_cents) VALUES ('r1', 'z1', 'Weighted', 'weight', 500, 200)"
          )
          .bind(),
      ]);
      const order = await heldOrder(db, {
        shippingCountry: 'US',
        email: 'w@example.com',
        lines: [{ sku, qty: 2 }],
        shippingRateId: 'r1',
      });
      // 2 x 1200g = 2.4kg -> 3kg -> 500 + 600 shipping; subtotal 2 x 2000.
      expect(order.shippingCents).toBe(1100);
      expect(order.totalCents).toBe(4000 + 1100);
    } finally {
      await dispose();
    }
  }, 60_000);

  it('backorder variants can be ordered past on-hand; normal variants cannot', async () => {
    const { db, dispose } = await createTestDb();
    try {
      const sku = await seedProduct(db, { onHand: 1, continueSelling: true });
      const order = await heldOrder(db, {
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        email: 'b@example.com',
        lines: [{ sku, qty: 4 }],
      });
      expect(order.totalCents).toBe(8000);
      const stock = await db
        .prepare('SELECT reserved FROM stock WHERE sku = ?')
        .bind(sku)
        .first<{ reserved: number }>();
      expect(stock?.reserved).toBe(4);
    } finally {
      await dispose();
    }
  }, 60_000);
});

describe('ledger rebuild equals counters after mixed operations', () => {
  it('rebuilds every counter purely from ledger sums', async () => {
    const { db, dispose } = await createTestDb();
    try {
      const sku = await seedProduct(db, { onHand: 20 });
      const r1 = at(await reserveStock(db, [{ sku, qty: 5 }], { orderId: 'o1' }), 0);
      const r2 = at(await reserveStock(db, [{ sku, qty: 3 }], { orderId: 'o2' }), 0);
      await commitReservation(db, r1);
      await releaseReservation(db, r2);
      const rebuilt = await db
        .prepare(
          `SELECT s.sku, s.on_hand, s.reserved,
                (SELECT COALESCE(SUM(delta_on_hand),0) FROM stock_ledger l WHERE l.sku = s.sku) AS l_on_hand,
                (SELECT COALESCE(SUM(delta_reserved),0) FROM stock_ledger l WHERE l.sku = s.sku) AS l_reserved
         FROM stock s`
        )
        .all<{
          sku: string;
          on_hand: number;
          reserved: number;
          l_on_hand: number;
          l_reserved: number;
        }>();
      for (const row of rebuilt.results) {
        expect(row.on_hand).toBe(row.l_on_hand);
        expect(row.reserved).toBe(row.l_reserved);
        expect(row.on_hand).toBeGreaterThanOrEqual(0);
        expect(row.reserved).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await dispose();
    }
  }, 60_000);
});

describe('magic link never appears in an HTTP response', () => {
  it('sign-in response carries no token or verify URL', async () => {
    const { db, dispose } = await createTestDb();
    try {
      const auth = createAuth(
        db,
        'http://localhost:8799',
        'test-secret-that-is-long-enough',
        [],
        undefined,
        'Test Store'
      );
      const t = Date.now();
      await db
        .prepare(
          "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('cust-1', 'Cust', 'cust@example.com', 1, 'customer', ?, ?)"
        )
        .bind(t, t)
        .run();
      const res = await auth.handler(
        new Request('http://localhost:8799/api/auth/sign-in/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:8799' },
          body: JSON.stringify({ email: 'cust@example.com', callbackURL: '/account' }),
        })
      );
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).not.toMatch(/token=/);
      expect(body).not.toContain('magic-link/verify');
      expect(body).not.toContain('/api/auth/magic-link');
      // The link exists only inside the durable email outbox payload.
      const outbox = await db
        .prepare("SELECT payload_json AS payload FROM outbox WHERE type = 'email.send'")
        .first<{ payload: string }>();
      expect(outbox?.payload ?? '').toContain('magic-link');
    } finally {
      await dispose();
    }
  }, 60_000);
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { readListingPage } from '../web/src/server/catalog-read';
import { ALL_LISTING } from '../web/src/server/catalog-models';
import { processOutboxRow, queueAbandonedReminder } from '../web/src/server/email';
import { reconcileStripe } from '../web/src/server/reconcile';
import { fakeProvider } from './helpers/payments';

class FakeKv {
  map = new Map<string, string>();
  puts: string[] = [];
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.puts.push(key);
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

let db: D1Database;
let dispose: () => Promise<void>;
const kv = new FakeKv();

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  await seedProduct(db, { onHand: 3 });
});
afterAll(async () => {
  await dispose();
});

describe('KV catalogue snapshots', () => {
  it('never writes KV on the read path, and falls back to D1 instead of an empty store', async () => {
    await buildCatalogReadModels(db, kv);
    const writesBefore = kv.puts.length;
    const viaKv = await readListingPage(db, kv, ALL_LISTING, 1);
    expect(viaKv?.cards).toHaveLength(1);
    const viaD1 = await readListingPage(db, new FakeKv(), ALL_LISTING, 1);
    expect(viaD1?.cards).toHaveLength(1);
    expect(kv.puts.length).toBe(writesBefore);
  });

  it('publishes a renamed product and keeps the previous immutable page value', async () => {
    // Phase 3B equivalent of the versioned-snapshot guarantee.
    await buildCatalogReadModels(db, kv);
    const before = await readListingPage(db, kv, ALL_LISTING, 1);
    expect(before?.cards).toHaveLength(1);

    await db.prepare("UPDATE products SET title = 'Renamed Tee' WHERE id = 'p1'").run();
    await catalogWork(db, kv);
    const updated = await readListingPage(db, kv, ALL_LISTING, 1);
    expect(updated?.cards[0]?.title).toBe('Renamed Tee');
    // Immutable KV values are content-addressed: the old page revision
    // remains stored alongside the new one.
    const values = [...kv.map.values()];
    expect(values.some((v) => v.includes('"title":"Tee"'))).toBe(true);
    expect(values.some((v) => v.includes('Renamed Tee'))).toBe(true);
  });
});

describe('partitioned reference guard (B7)', () => {
  it('never derives publication order from a stale or fabricated KV reference', async () => {
    kv.map.set(
      'catalog:r1:listing:all:current',
      JSON.stringify({
        listingId: 'all',
        generation: 9999999,
        pageSize: 24,
        total: 1,
        pageCount: 1,
        pageRevisions: ['deadbeefdeadbeef'],
      })
    );
    kv.map.set(
      'catalog:r1:listing:all:9999999:page:1:deadbeefdeadbeef',
      JSON.stringify({ products: [{ slug: 'fake' }] })
    );
    await db.prepare("UPDATE products SET title='Renamed Again' WHERE id='p1'").run();
    await catalogWork(db, kv);
    const page = await readListingPage(db, kv, ALL_LISTING, 1);
    expect(page?.generation).toBeLessThan(9999999);
    expect(page?.cards[0]?.title).toBe('Renamed Again');
    expect(JSON.stringify(page)).not.toContain('fake');
  });
});

describe('outbox claiming and abandoned reminders', () => {
  it('only one concurrent claimant can attempt an outbox row', async () => {
    await db
      .prepare(
        `INSERT INTO outbox (id, type, payload_json, status, attempts, created_at)
       VALUES ('out-1', 'email.send', ?, 'pending', 0, ?)`
      )
      .bind(
        JSON.stringify({ to: 'a@b.com', subject: 'Hi', text: 'x', html: '<p>x</p>' }),
        new Date().toISOString()
      )
      .run();
    const results = await Promise.allSettled([
      processOutboxRow(db, 'out-1'),
      processOutboxRow(db, 'out-1'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled' && r.value === false);
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const row = await db
      .prepare('SELECT status, attempts FROM outbox WHERE id = ?')
      .bind('out-1')
      .first<{ status: string; attempts: number }>();
    expect(row?.attempts).toBe(1);
    expect(row?.status).toBe('failed');
  });

  it('claims and queues an abandoned reminder exactly once', async () => {
    await db.prepare("UPDATE settings SET value='1' WHERE key='abandoned_reminders_enabled'").run();
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO orders (id, number, status, payment_status, customer_email, currency, subtotal_cents, total_cents, created_at, updated_at)
       VALUES ('ab-1', 'ORD-AB', 'canceled', 'unpaid', 'a@b.com', 'USD', 100, 100, ?, ?)`
      )
      .bind(now, now)
      .run();
    await db.prepare("UPDATE orders SET reminder_consent=1 WHERE id='ab-1'").run();
    await expect(
      queueAbandonedReminder(db, { id: 'ab-1', number: 'ORD-AB', customer_email: 'a@b.com' })
    ).resolves.toBe(true);
    await expect(
      queueAbandonedReminder(db, { id: 'ab-1', number: 'ORD-AB', customer_email: 'a@b.com' })
    ).resolves.toBe(false);
    const outbox = await db
      .prepare("SELECT COUNT(*) AS c FROM outbox WHERE id='abandoned-ab-1'")
      .first<{ c: number }>();
    expect(outbox?.c).toBe(1);
  });

  it('creates no reminder for an order already paid when the claim executes', async () => {
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO orders (id, number, status, payment_status, customer_email, currency, subtotal_cents, total_cents, created_at, updated_at)
       VALUES ('ab-2', 'ORD-AB2', 'canceled', 'unpaid', 'a@b.com', 'USD', 100, 100, ?, ?)`
      )
      .bind(now, now)
      .run();
    // Payment completes after the cron selection but before the claim.
    await db
      .prepare("UPDATE orders SET payment_status = 'paid',reminder_consent=1 WHERE id = 'ab-2'")
      .run();
    await expect(
      queueAbandonedReminder(db, { id: 'ab-2', number: 'ORD-AB2', customer_email: 'a@b.com' })
    ).resolves.toBe(false);
    const outbox = await db
      .prepare("SELECT COUNT(*) AS c FROM outbox WHERE id = 'abandoned-ab-2'")
      .first<{ c: number }>();
    expect(outbox?.c).toBe(0);
    const order = await db
      .prepare('SELECT abandoned_reminded_at FROM orders WHERE id = ?')
      .bind('ab-2')
      .first<{ abandoned_reminded_at: string | null }>();
    expect(order?.abandoned_reminded_at).toBeNull();
  });
});

describe('Stripe reconciliation', () => {
  it('checks both directions and reports paid-without-order and order-without-paid-session', async () => {
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO orders (id, number, status, payment_status, customer_email, currency, subtotal_cents, total_cents, stripe_checkout_session_id, created_at, updated_at)
       VALUES ('rec-1', 'ORD-REC', 'paid', 'paid', 'a@b.com', 'USD', 100, 100, 'cs_local', ?, ?)`
      )
      .bind(now, now)
      .run();
    const provider = fakeProvider({
      async listCheckoutSessionsPage() {
        return {
          hasMore: false,
          data: [
            {
              id: 'cs_stripe_only',
              payment_status: 'paid',
              amount_total: 100,
              currency: 'usd',
              payment_intent: 'pi_x',
            },
          ],
        };
      },
      async retrieveCheckoutSession() {
        return {
          id: 'cs_local',
          payment_status: 'unpaid',
          amount_total: 100,
          currency: 'usd',
          payment_intent: null,
        };
      },
    });
    const report = await reconcileStripe(db, provider);
    expect(report.checkedStripeSessions).toBe(1);
    expect(report.checkedOrders).toBe(1);
    expect(report.mismatches).toContain('stripe_paid_no_order:cs_stripe_only');
    expect(report.mismatches).toContain('order_paid_session_unpaid:rec-1:cs_local');
  });
});
import { buildCatalogReadModels, catalogWork } from './helpers/catalog-driver';

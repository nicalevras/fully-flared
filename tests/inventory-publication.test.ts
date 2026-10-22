import { PUBLISHED_SETTING_KEYS } from '../web/src/schemas/settings';
import { deliverStripeEvent } from './helpers/webhook';
import { LIMIT_DEFINITIONS, isLimitKey } from '../web/src/schemas/limits';
import {
  createPendingOrder,
  cancelOrderById,
  attachStripeSession,
} from '../web/src/server/checkout';
import { requestRefund } from '../web/src/server/refunds';
import { adjustStock } from '../web/src/server/inventory';
import { expectLedgerMatchesCounters } from './helpers/d1';
import type { PaymentProvider } from '../web/src/server/payments';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import {
  enqueueCatalogRebuild,
  ensureCatalogReadModels,
  processCatalogWork,
} from '../web/src/server/catalog-publisher';
import { readListingPage } from '../web/src/server/catalog-read';
import { getStorefrontLayout } from '../web/src/server/catalog-read';
import { ALL_LISTING } from '../web/src/server/catalog-models';
let db: D1Database, dispose: () => Promise<void>;
beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  await seedProduct(db);
});
afterAll(async () => {
  await dispose();
});
const revision = async () =>
  (await db
    .prepare('SELECT COALESCE(SUM(target_revision),0) AS n FROM catalog_work')
    .first<{ n: number }>())!.n;
it('stock changes and currency locks do not dirty publication; actual layout edits do', async () => {
  const before = await revision();
  for (const sql of [
    'UPDATE stock SET reserved=reserved+1',
    'UPDATE stock SET reserved=reserved-1',
    'UPDATE stock SET on_hand=on_hand-1',
    'UPDATE stock SET on_hand=on_hand+1',
    "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('currency_locked','1','now')",
  ])
    await db.prepare(sql).run();
  expect(await revision()).toBe(before);
  await db
    .prepare(
      "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('store_name','New name','now')"
    )
    .run();
  expect(await revision()).toBe(before + 1);
  await db
    .prepare("UPDATE settings SET value=value,updated_at='later' WHERE key='store_name'")
    .run();
  expect(await revision()).toBe(before + 1);
  await db.prepare("UPDATE products SET title='Changed' WHERE id='p1'").run();
  expect(await revision()).toBe(before + 2);
});
it('enqueue does not invent edits; a clean pass publishes nothing and layout recovers from D1', async () => {
  const values = new Map<string, string>();
  const send = vi.fn();
  const kv = {
    get: async (k: string) => values.get(k) ?? null,
    put: async (k: string, v: string) => {
      values.set(k, v);
    },
    delete: async (k: string) => {
      values.delete(k);
    },
  };
  const env = { DB: db, CATALOG_JOBS: { send } as never, CATALOG_KV: kv as never };
  const before = await revision();
  await enqueueCatalogRebuild(env);
  // The wake-up invents no edits: durable capture is the triggers' job.
  expect(await revision()).toBe(before);
  expect(send).toHaveBeenCalledOnce();
  await ensureCatalogReadModels(db, kv);
  await processCatalogWork(db, kv);
  const sizeAfterDrain = values.size;
  const clean = await processCatalogWork(db, kv);
  expect(clean.processed).toBe(0);
  expect(values.size).toBe(sizeAfterDrain);
  // Missing KV values recover from D1 payloads/source, never blank.
  values.clear();
  const layout = await getStorefrontLayout(db, env);
  expect(layout.storeName).toBeTruthy();
  const page = await readListingPage(db, kv, ALL_LISTING, 1);
  expect(page?.cards[0]).not.toHaveProperty('available');
});

it('cron promotes due scheduled posts and preserves future scheduling', async () => {
  await db
    .prepare(
      "INSERT INTO posts(id,slug,title,status,published_at,created_at,updated_at) VALUES('due','due','Due','scheduled','2020-01-01','now','now'),('future','future','Future','scheduled','2099-01-01','now','now')"
    )
    .run();
  await processCatalogWork(db);
  expect((await db.prepare("SELECT status FROM posts WHERE id='due'").first())?.status).toBe(
    'published'
  );
  expect((await db.prepare("SELECT status FROM posts WHERE id='future'").first())?.status).toBe(
    'scheduled'
  );
});

it('reserve, cancel, payment, refund/restock and adjustments preserve publication keys and balanced stock', async () => {
  const fixture = await createTestDb();
  const db = fixture.db;
  try {
    await seedProduct(db, { onHand: 10 });
    const data = new Map<string, string>();
    const put = vi.fn(async (k: string, v: string) => {
      data.set(k, v);
    });
    const send = vi.fn();
    const env = {
      CATALOG_JOBS: { send } as never,
      CATALOG_KV: { get: async (k: string) => data.get(k) ?? null, put } as never,
    };
    await buildCatalogReadModels(db, env.CATALOG_KV);
    await processCatalogWork(db, env.CATALOG_KV);
    const before = await db
      .prepare('SELECT COALESCE(SUM(target_revision),0) AS n FROM catalog_work')
      .first();
    const writes = put.mock.calls.length;
    const create = () =>
      createPendingOrder(db, {
        email: 'fixture@example.test',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      });
    const canceled = await create();
    await cancelOrderById(db, canceled.orderId);
    const paid = await create();
    await attachStripeSession(db, paid.orderId, 'cs_publication');
    const provider: PaymentProvider = {
      createCheckout: async () => ({ sessionId: 'unused', url: 'https://example.test' }),
      verifyWebhook: async (raw) => {
        const e = JSON.parse(raw);
        return { ...e, data: e.data.object };
      },
      refund: async () => ({ id: 're_publication', status: 'succeeded' }),
    };
    await deliverStripeEvent(
      db,
      provider,
      JSON.stringify({
        id: 'evt_publication',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_publication',
            payment_status: 'paid',
            payment_intent: 'pi_publication',
            amount_total: paid.totalCents,
            currency: 'usd',
            metadata: { order_id: paid.orderId },
            collected_information: {
              shipping_details: { name: 'Fixture', address: { line1: 'Fixture', country: 'US' } },
            },
          },
        },
      }),
      'test'
    );
    await requestRefund(db, provider, {
      orderId: paid.orderId,
      requestId: 'refund-publication',
      purpose: 'staff',
      restock: true,
    });
    await adjustStock(db, 'TEE-1', -1, 'correction');
    await adjustStock(db, 'TEE-1', 1, 'restock');
    expect(
      await db.prepare('SELECT COALESCE(SUM(target_revision),0) AS n FROM catalog_work').first()
    ).toEqual(before);
    const second = await processCatalogWork(db, env.CATALOG_KV);
    expect(second.productsPublished).toBe(0);
    expect(put).toHaveBeenCalledTimes(writes);
    expect(await expectLedgerMatchesCounters(db, 'TEE-1')).toEqual({ on_hand: 10, reserved: 0 });
  } finally {
    await fixture.dispose();
  }
});

it('every published setting dirties only on change; unrelated settings never dirty on insert/update/delete', async () => {
  // Currency edits need an unlocked fixture, independent of the earlier paid-order checks.
  const fixture = await createTestDb();
  const db = fixture.db;
  const revision = async () =>
    (await db
      .prepare('SELECT COALESCE(SUM(target_revision),0) AS n FROM catalog_work')
      .first<{ n: number }>())!.n;
  try {
    for (const key of PUBLISHED_SETTING_KEYS) {
      const existing = await db
        .prepare('SELECT value FROM settings WHERE key=?')
        .bind(key)
        .first<{ value: string }>();
      const candidate = isLimitKey(key)
        ? String(
            existing?.value === String(LIMIT_DEFINITIONS[key].min)
              ? LIMIT_DEFINITIONS[key].max
              : LIMIT_DEFINITIONS[key].min
          )
        : key === 'canonical_base_url'
          ? 'https://layout.example.test'
          : key === 'currency'
            ? 'EUR'
            : 'changed-' + key;
      const before = await revision();
      await db
        .prepare(
          "INSERT INTO settings(key,value,updated_at) VALUES(?,?,'now') ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        )
        .bind(key, candidate)
        .run();
      expect(await revision()).toBe(before + 1);
      await db.prepare('UPDATE settings SET value=value WHERE key=?').bind(key).run();
      expect(await revision()).toBe(before + 1);
    }
    const before = await revision();
    await db
      .prepare(
        "INSERT INTO settings(key,value,updated_at) VALUES('email_from_name','first','now') ON CONFLICT(key) DO UPDATE SET value='first'"
      )
      .run();
    await db.prepare("UPDATE settings SET value='second' WHERE key='email_from_name'").run();
    await db.prepare("DELETE FROM settings WHERE key='email_from_name'").run();
    expect(await revision()).toBe(before);
  } finally {
    await fixture.dispose();
  }
});
it('partitioned readers never query stock and ignore fabricated references', async () => {
  const values = new Map<string, string>();
  const kv = {
    get: async (k: string) => values.get(k) ?? null,
    put: async (k: string, v: string) => {
      values.set(k, v);
    },
    delete: async (k: string) => {
      values.delete(k);
    },
  };
  const queries: string[] = [];
  const traced = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          queries.push(sql);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await buildCatalogReadModels(traced, kv);
  expect(queries.some((sql) => /\b(?:FROM|JOIN)\s+"?stock\b/i.test(sql))).toBe(false);
  // A fabricated listing reference is validated and ignored in favour
  // of the D1 payload, never trusted as publication state.
  values.set(
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
  const page = await readListingPage(traced, kv, ALL_LISTING, 1);
  expect(page?.cards.length).toBeGreaterThan(0);
  expect(page?.generation).toBeLessThan(9999999);
});
import { buildCatalogReadModels } from './helpers/catalog-driver';

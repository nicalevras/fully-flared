import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';
import { catalogQueueHarness } from './helpers/catalog-queue';
import { claimCatalogLease, releaseCatalogLease } from '../web/src/server/catalog-exec';

class Kv {
  map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

let db: D1Database, env: Cloudflare.Env;
let dispose: () => Promise<void>;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  ({ db, env, dispose } = await createTestDb());
});
afterEach(async () => {
  vi.useRealTimers();
  await dispose();
});

async function idleCatalogue(kv: Kv) {
  await db
    .prepare(
      "INSERT INTO catalog_listings(listing_id,generation,page_size,page_count,total,active,updated_at) VALUES('all',1,24,0,0,1,'2000')"
    )
    .run();
  await kv.put('catalog:r1:listing:all:current', '{}');
  await db.prepare('UPDATE catalog_work SET processed_revision=target_revision').run();
}

it('backs off instead of re-enqueueing immediately while another invocation holds the lease', async () => {
  const kv = new Kv();
  const queue = await catalogQueueHarness(db, kv, env);
  const lease = await claimCatalogLease(db);
  expect(lease).not.toBeNull();
  const delivery = await queue.deliver();
  expect(delivery.retried).toBe(false);
  expect(delivery.continued).toBe(true);
  expect(delivery.sendOptions).toEqual({ delaySeconds: 5 });
  if (lease) await releaseCatalogLease(db, lease);
});

it('advances garbage collection even while catalogue work is due', async () => {
  const kv = new Kv();
  await idleCatalogue(kv);
  await db
    .prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES('store_name','Busy store','2026') ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    .run();
  const due = await db
    .prepare('SELECT COUNT(*) AS n FROM catalog_work WHERE processed_revision<target_revision')
    .first<{ n: number }>();
  expect(due?.n).toBeGreaterThan(0);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO maintenance_runs(id,task,cutoff,next_at,started_at,updated_at)
    VALUES('gc-busy','gc',?,?,?,?)`
    )
    .bind(now, now, now, now)
    .run();
  const queue = await catalogQueueHarness(db, kv, env);
  const result = await queue.deliver({ type: 'maintenance.run', runId: 'gc-busy' });
  expect(result.retried).toBe(false);
  expect(await db.prepare('SELECT phase FROM catalog_gc_state').first()).toMatchObject({
    phase: 'inventory',
  });
});

it('publishes a small catalogue in at most two queue deliveries', async () => {
  const kv = new Kv();
  const createdAt = '2026-01-01T00:00:00.000Z';
  for (let i = 0; i < 6; i++) {
    await db.batch([
      db
        .prepare(
          "INSERT INTO products(id,slug,title,description,status,created_at,updated_at) VALUES(?,?,?,'desc','active',?,?)"
        )
        .bind(`p${i}`, `slug-${i}`, `Product ${i}`, createdAt, createdAt),
      db
        .prepare(
          "INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) VALUES(?,?,?,'Default',1000,'active',?)"
        )
        .bind(`v${i}`, `p${i}`, `SKU-${i}`, createdAt),
      db
        .prepare('INSERT INTO stock(sku,on_hand,reserved,updated_at) VALUES(?,50,0,?)')
        .bind(`SKU-${i}`, createdAt),
    ]);
  }
  const queue = await catalogQueueHarness(db, kv, env);
  let deliveries = 0;
  for (let continued = true; continued && deliveries < 50; deliveries++) {
    const delivery = await queue.deliver();
    expect(delivery.retried).toBe(false);
    continued = delivery.continued;
  }
  expect(deliveries).toBeLessThanOrEqual(2);
  expect(kv.map.has('catalog:r1:listing:all:current')).toBe(true);
});

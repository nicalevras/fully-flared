import { catalogQueueHarness } from './helpers/catalog-queue';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { BUSY_RETRY_SECONDS, runCatalogUnit } from '../web/src/server/catalog-publisher';
import { readListingPage } from '../web/src/server/catalog-read';
import {
  CATALOG_BUDGET_LIMITS,
  CatalogBudget,
  claimCatalogLease,
  leaseGuardStatement,
} from '../web/src/server/catalog-exec';
import { ALL_LISTING } from '../web/src/server/catalog-models';
import { catalogPass, catalogWork } from './helpers/catalog-driver';
import { present } from './helpers/fixtures';

// Round 2 regressions: the ACTUAL queue execution path (runCatalogUnit
// with a fresh budget per invocation, enforcing the 1,000 KV-op
// platform limit per invocation) — not helper-level budgets.

class EnforcingKv {
  map = new Map<string, string>();
  invocationOps = 0;
  maxInvocationOps = 0;
  beginInvocation() {
    this.invocationOps = 0;
  }
  private count() {
    this.invocationOps++;
    this.maxInvocationOps = Math.max(this.maxInvocationOps, this.invocationOps);
    if (this.invocationOps > 1000) throw new Error('KV invocation budget exceeded');
  }
  async get(key: string) {
    this.count();
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.count();
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

let db: D1Database, dispose: () => Promise<void>;
let kv: EnforcingKv;

async function product(id: string, title: string, createdAt: string) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO products(id,slug,title,description,status,created_at,updated_at) VALUES(?,?,?,'desc','active',?,?)"
      )
      .bind(id, `slug-${id}`, title, createdAt, createdAt),
    db
      .prepare(
        "INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) VALUES(?,?,?,?,?,'active',?)"
      )
      .bind(`v-${id}`, id, `SKU-${id}`, 'Default', 1000, createdAt),
    db
      .prepare('INSERT INTO stock(sku,on_hand,reserved,updated_at) VALUES(?,50,0,?)')
      .bind(`SKU-${id}`, createdAt),
  ]);
}

async function seedProducts(n: number) {
  for (let s = 0; s < n; s += 250) {
    const rows = Array.from({ length: Math.min(250, n - s) }, (_, k) => {
      const i = s + k;
      return {
        id: `p${i}`,
        created: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      };
    });
    const json = JSON.stringify(rows);
    await db.batch([
      db
        .prepare(
          `INSERT INTO products(id,slug,title,description,status,created_at,updated_at)
           SELECT json_extract(value,'$.id'), 'slug-' || json_extract(value,'$.id'), 'Product ' || json_extract(value,'$.id'), 'desc', 'active', json_extract(value,'$.created'), json_extract(value,'$.created') FROM json_each(?)`
        )
        .bind(json),
      db
        .prepare(
          `INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at)
           SELECT 'v' || json_extract(value,'$.id'), json_extract(value,'$.id'), 'SKU-' || json_extract(value,'$.id'), 'Default', 1000, 'active', json_extract(value,'$.created') FROM json_each(?)`
        )
        .bind(json),
      db
        .prepare(
          `INSERT INTO stock(sku,on_hand,reserved,updated_at)
           SELECT 'SKU-' || json_extract(value,'$.id'), 50, 0, json_extract(value,'$.created') FROM json_each(?)`
        )
        .bind(json),
    ]);
  }
}

async function driveUnits(max = 500): Promise<number> {
  const queue = await catalogQueueHarness(db, kv);
  let units = 0;
  for (; units < max; units++) {
    kv.beginInvocation();
    const res = await queue.deliver();
    expect(res.d1).toBeLessThanOrEqual(CATALOG_BUDGET_LIMITS.d1Statements);
    expect(res.retried).toBe(false);
    if (!res.continued) return units + 1;
  }
  throw new Error('units did not converge');
}

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  kv = new EnforcingKv();
});

describe('Round 2 bounded catalog execution', () => {
  it('bootstrap acknowledges captured revisions and leaves a mid-build edit due', async () => {
    await product('captured', 'Before', '2026-01-01');
    const original = kv.put.bind(kv);
    let edited = false;
    kv.put = async (key, value) => {
      await original(key, value);
      if (!edited && key.startsWith('catalog:r1:product:')) {
        edited = true;
        await db.prepare("UPDATE products SET title='After' WHERE id='captured'").run();
      }
    };
    const queue = await catalogQueueHarness(db, kv);
    for (let i = 0; i < 100; i++) {
      const delivery = await queue.deliver();
      expect(delivery.retried).toBe(false);
      const build = await db
        .prepare("SELECT state FROM catalog_builds WHERE kind='full' LIMIT 1")
        .first<{ state: string }>();
      if (build?.state === 'done') break;
    }
    const work = await db
      .prepare(
        "SELECT processed_revision,target_revision FROM catalog_work WHERE id='product:captured'"
      )
      .first<{ processed_revision: number; target_revision: number }>();
    expect(edited).toBe(true);
    const { processed_revision, target_revision } = present(work);
    expect(processed_revision).toBeLessThan(target_revision);
    kv.put = original;
    for (let i = 0; i < 30; i++) {
      const delivery = await queue.deliver();
      expect(delivery.retried).toBe(false);
      const pending = await db
        .prepare(
          "SELECT 1 FROM catalog_work WHERE id='product:captured' AND processed_revision<target_revision"
        )
        .first();
      if (!pending) break;
    }
    const page = await readListingPage(db, undefined, ALL_LISTING, 1);
    expect(page?.cards[0]?.title).toBe('After');
    await dispose();
  });
  it('sizes a bootstrap slice using variant fan-out before returning source rows', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `wide-${i}`);
    const variants = ids.flatMap((id) =>
      Array.from({ length: 100 }, (_, i) => ({ id: `${id}-v${i}`, product: id }))
    );
    await db.batch([
      db
        .prepare(
          "INSERT INTO products(id,slug,title,description,status,created_at,updated_at) SELECT value,value,value,'','active','2026-01-01','2026-01-01' FROM json_each(?)"
        )
        .bind(JSON.stringify(ids)),
      db
        .prepare(
          "INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.product'),json_extract(value,'$.id'),'D',100,'active','2026-01-01' FROM json_each(?)"
        )
        .bind(JSON.stringify(variants)),
    ]);
    const queue = await catalogQueueHarness(db, kv);
    for (let i = 0; i < 3; i++) {
      const result = await queue.deliver();
      expect(result.retried).toBe(false);
      expect(result.rows).toBeLessThanOrEqual(5000);
    }
    const n = await db.prepare('SELECT COUNT(*) AS n FROM catalog_cards').first<{ n: number }>();
    expect(present(n).n).toBeGreaterThan(0);
    await dispose();
  });
  it('retries a failed continuation send without acknowledging the message', async () => {
    // Large enough that the first invocation cannot finish the publish.
    await seedProducts(501);
    const queue = await catalogQueueHarness(db, kv);
    queue.failNextSend();
    const failed = await queue.deliver();
    expect(failed.retried).toBe(true);
    expect(failed.acked).toBe(false);
    const retry = await queue.deliver();
    expect(retry.acked).toBe(true);
    expect(retry.retried).toBe(false);
    await dispose();
  });
  it('catalog queue consumer batch size stays 1 (production and preview)', () => {
    const config = readFileSync(join(process.cwd(), 'web', 'wrangler.jsonc'), 'utf8');
    // Every consumer block for a catalog queue (base + preview envs)
    // must keep max_batch_size at 1: the invocation budget assumes
    // one message per invocation.
    const blocks = config.match(/\{[^{}]*"queue":\s*"store-catalog[^"]*"[^{}]*\}/g) ?? [];
    const consumers = blocks.filter((b) => b.includes('max_batch_size'));
    expect(consumers.length).toBeGreaterThanOrEqual(2);
    for (const block of consumers) {
      expect(block).toContain('"max_batch_size": 1');
    }
  });

  it(
    'queue bootstrap at 501 products stays within per-invocation budgets',
    { timeout: 240_000 },
    async () => {
      await seedProducts(501);
      await db.prepare('UPDATE catalog_work SET processed_revision = target_revision').run();
      const units = await driveUnits();
      expect(units).toBeGreaterThan(1);
      expect(kv.maxInvocationOps).toBeLessThanOrEqual(1000);
      const page = await readListingPage(db, kv, ALL_LISTING, 1);
      expect(page?.total).toBe(501);
      const last = await readListingPage(db, kv, ALL_LISTING, present(page).pageCount);
      expect(last?.cards.length ?? 0).toBeGreaterThan(0);
      await dispose();
    }
  );

  it(
    'one product edit at 501 products does not read the whole catalog',
    { timeout: 240_000 },
    async () => {
      await seedProducts(501);
      await driveUnits();
      await db.prepare('UPDATE catalog_work SET processed_revision = target_revision').run();
      await db.prepare("UPDATE products SET title='Edited title' WHERE id='p250'").run();
      const putsBefore = kv.map.size;
      void putsBefore;
      let puts = 0;
      const realPut = kv.put.bind(kv);
      kv.put = async (k: string, v: string) => {
        puts++;
        return realPut(k, v);
      };
      const res = await catalogWork(db, kv);
      kv.put = realPut;
      expect(res.processed).toBe(1);
      expect(puts).toBeLessThanOrEqual(12);
      const pageNum = await db
        .prepare(
          "SELECT page FROM catalog_page_products WHERE product_id='p250' AND listing_id='all' AND generation=(SELECT generation FROM catalog_listings WHERE listing_id='all' AND active=1)"
        )
        .first<{ page: number }>();
      const page = await readListingPage(db, kv, ALL_LISTING, present(pageNum).page);
      expect(page?.cards.some((c) => c.title === 'Edited title')).toBe(true);
      await dispose();
    }
  );

  it('a held publisher lease makes a concurrent unit a harmless no-op', async () => {
    await product('p1', 'One', '2026-01-01');
    const lease = await claimCatalogLease(db);
    expect(lease).not.toBeNull();
    const res = await runCatalogUnit(db, kv, { budget: new CatalogBudget() });
    expect(res).toEqual({ done: false, busy: true, retryAfterSeconds: BUSY_RETRY_SECONDS });
    await db
      .prepare(
        'UPDATE catalog_publication_state SET lease_token = NULL, lease_expires_at = NULL WHERE id = 1'
      )
      .run();
    await driveUnits(50);
    const page = await readListingPage(db, kv, ALL_LISTING, 1);
    expect(page?.total).toBe(1);
    await dispose();
  });

  it('a stale lease guard aborts its commit batch; fencing increments monotonically', async () => {
    const a = present(await claimCatalogLease(db), 'lease A');
    // While A is held, no second claim succeeds.
    expect(await claimCatalogLease(db)).toBeNull();
    // Expire A; B takes over with a higher fencing generation.
    await db
      .prepare(
        "UPDATE catalog_publication_state SET lease_expires_at = '2000-01-01 00:00:00' WHERE id = 1"
      )
      .run();
    const b = present(await claimCatalogLease(db), 'lease B');
    expect(b.fencing).toBeGreaterThan(a.fencing);
    // A's guarded batch now aborts (zero committed side effects).
    await expect(
      db.batch([
        leaseGuardStatement(db, a),
        db.prepare('UPDATE catalog_publication_state SET publication_seq = 999 WHERE id = 1'),
      ])
    ).rejects.toThrow();
    const seq = await db
      .prepare('SELECT publication_seq FROM catalog_publication_state WHERE id = 1')
      .first<{ publication_seq: number }>();
    expect(seq?.publication_seq).not.toBe(999);
    await dispose();
  });

  it(
    'shared-image fan-out over 90 products resumes by keyset cursor',
    { timeout: 180_000 },
    async () => {
      await seedProducts(95);
      await driveUnits();
      await db.prepare('UPDATE catalog_work SET processed_revision = target_revision').run();
      // One image linked to all 95 products.
      await db.batch([
        db.prepare(
          "INSERT INTO media(id,r2_key,filename,content_type,alt_text,created_at) VALUES('m1','k/m1','f.jpg','image/jpeg','','2026-01-01')"
        ),
        db
          .prepare(
            `INSERT INTO product_media(product_id,media_id,position)
         SELECT 'p' || value, 'm1', 0 FROM json_each(?)`
          )
          .bind(JSON.stringify(Array.from({ length: 95 }, (_, i) => i))),
      ]);
      await db.prepare('UPDATE catalog_work SET processed_revision = target_revision').run();
      await db.prepare("UPDATE media SET r2_key='k/m1-v2' WHERE id='m1'").run();
      const first = await catalogPass(db, kv);
      // First pass fans out one bounded slice and leaves the media row due.
      expect(first.more).toBe(true);
      const second = await catalogPass(db, kv);
      expect(second.more).toBeFalsy();
      const docs = await db
        .prepare('SELECT COUNT(*) AS n FROM catalog_documents WHERE kind = ?')
        .bind('product')
        .first<{ n: number }>();
      expect(docs?.n).toBeGreaterThanOrEqual(95);
      await dispose();
    }
  );

  it('empty store: bounded browsing before, during and after initial publication', async () => {
    // Before: no publication — bounded empty response, no throw.
    expect(await readListingPage(db, kv, ALL_LISTING, 1)).toBeNull();
    // During: one unit only (publication incomplete) — still bounded.
    kv.beginInvocation();
    await runCatalogUnit(db, kv, { budget: new CatalogBudget() });
    const during = await readListingPage(db, kv, ALL_LISTING, 1);
    expect(during === null || during.cards.length === 0).toBe(true);
    // After: units complete; the empty listing serves an empty page.
    await driveUnits(50);
    const after = await readListingPage(db, kv, ALL_LISTING, 1);
    expect(after?.total).toBe(0);
    expect(after?.cards).toEqual([]);
    await dispose();
  });
});

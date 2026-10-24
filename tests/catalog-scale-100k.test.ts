import { catalogQueueHarness } from './helpers/catalog-queue';
import { expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { readListingPage } from '../web/src/server/catalog-read';
import { ALL_LISTING } from '../web/src/server/catalog-models';

// Phase 3C acceptance gate: the partitioned catalog must build and
// serve 100,000 products with bounded values throughout. This is the
// agreed capacity evidence (10k fixtures in earlier phases were
// development evidence only).

class FakeKv {
  map = new Map<string, string>();
  puts = 0;
  putKeys: string[] = [];
  invocationOps = 0;
  maxInvocationOps = 0;
  /** Marks one publisher invocation boundary for budget accounting. */
  beginInvocation() {
    this.invocationOps = 0;
  }
  private countOp() {
    this.invocationOps++;
    this.maxInvocationOps = Math.max(this.maxInvocationOps, this.invocationOps);
    // The real platform fails a Worker invocation past 1,000 KV
    // operations. Enforcing it here makes the gate prove bounded
    // publication instead of merely observing a large put count.
    if (this.invocationOps > 1000) throw new Error('KV invocation budget exceeded');
  }
  async get(key: string) {
    this.countOp();
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.countOp();
    this.puts++;
    this.putKeys.push(key);
    this.map.set(key, value);
    // Real KV puts are network I/O and yield the event loop. An
    // instantly-resolving stub starves the loopback D1 socket during
    // the 200k-put build and the first later batch dies on a stale
    // connection, which no production path can reproduce.
    if (this.puts % 200 === 0) await new Promise((r) => setImmediate(r));
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

it(
  'builds and serves a 100,000-product catalogue with bounded values',
  // Includes physical handler work, revision acknowledgement and replica sweep.
  { timeout: 3_600_000 },
  async () => {
    const { db, dispose } = await createTestDb({ transportRetry: true });
    const kv = new FakeKv();
    try {
      const rows = Array.from({ length: 100_000 }, (_, i) => ({
        id: `bp${i}`,
        slug: `bulk-${i}`,
        // The first 1,000 products share one timestamp (tied
        // ordering), the rest are one second apart.
        created:
          i < 1000
            ? '2026-01-01T00:00:00.000Z'
            : new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      }));
      const seedStart = Date.now();
      for (let s = 0; s < rows.length; s += 1000) {
        const chunk = rows.slice(s, s + 1000);
        const json = JSON.stringify(chunk);
        await db.batch([
          db
            .prepare(
              `INSERT INTO products(id,slug,title,description,status,created_at,updated_at)
               SELECT json_extract(value,'$.id'), json_extract(value,'$.slug'), json_extract(value,'$.slug'), '', 'active', json_extract(value,'$.created'), json_extract(value,'$.created') FROM json_each(?)`
            )
            .bind(json),
          db
            .prepare(
              `INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at)
               SELECT 'v' || json_extract(value,'$.id'), json_extract(value,'$.id'), 'SKU-' || json_extract(value,'$.id'), 'D', 100, 'active', json_extract(value,'$.created') FROM json_each(?)`
            )
            .bind(json),
          db
            .prepare(
              `INSERT INTO stock(sku,on_hand,reserved,updated_at)
               SELECT 'SKU-' || json_extract(value,'$.id'), 10, 0, json_extract(value,'$.created') FROM json_each(?)`
            )
            .bind(json),
        ]);
      }
      console.warn(`100k seed: ${Date.now() - seedStart}ms`);
      // Images on the first 100 products, one manual collection
      // (3 products) and one rule collection (title contains
      // 'bulk-1'), so the gate covers variants, images and both
      // collection kinds at scale.
      await db.batch([
        db
          .prepare(
            `INSERT INTO media(id,r2_key,filename,content_type,alt_text,created_at)
             SELECT 'm' || json_extract(value,'$.id'), 'k/' || json_extract(value,'$.id'), 'f.jpg', 'image/jpeg', '', json_extract(value,'$.created') FROM json_each(?)`
          )
          .bind(JSON.stringify(rows.slice(0, 100))),
        db
          .prepare(
            `INSERT INTO product_media(product_id,media_id,position)
             SELECT json_extract(value,'$.id'), 'm' || json_extract(value,'$.id'), 0 FROM json_each(?)`
          )
          .bind(JSON.stringify(rows.slice(0, 100))),
        db.prepare(
          "INSERT INTO collections(id,slug,title,description,kind,rule_json,created_at) VALUES('cmanual','manual-picks','Manual picks','','manual',NULL,'2026-01-01')"
        ),
        db
          .prepare(
            "INSERT INTO collections(id,slug,title,description,kind,rule_json,created_at) VALUES('crule','bulk-ones','Bulk ones','','rule',?, '2026-01-01')"
          )
          .bind(JSON.stringify({ type: 'title_contains', value: 'bulk-1' })),
        db.prepare(
          "INSERT INTO product_collections(product_id,collection_id) VALUES('bp1','cmanual'),('bp2','cmanual'),('bp50000','cmanual')"
        ),
      ]);

      const buildStart = Date.now();
      // Drive the actual queue execution path: successive
      // runCatalogUnit invocations, each with a fresh shared budget
      // (reset only between real handler invocations). The enforcing
      // KV stub hard-fails any invocation past the 1,000-op platform
      // limit. Stop when the bootstrap build completes (the seeded
      // capture backlog is acknowledged separately below).
      const queue = await catalogQueueHarness(db, kv);
      let invocations = 0;
      for (let guard = 0; guard < 100_000; guard++) {
        kv.beginInvocation();
        const delivery = await queue.deliver();
        expect(delivery.retried).toBe(false);
        invocations++;
        expect(delivery.d1 + delivery.kv + delivery.other).toBeLessThanOrEqual(900);
        expect(delivery.kv).toBeLessThanOrEqual(800);
        const build = await db
          .prepare(
            "SELECT state FROM catalog_builds WHERE kind IN ('full','repair') ORDER BY created_at DESC LIMIT 1"
          )
          .first<{ state: string }>();
        const active = await db
          .prepare("SELECT generation FROM catalog_listings WHERE listing_id='all' AND active=1")
          .first();
        if (build?.state === 'done' && active) break;
      }
      expect(kv.maxInvocationOps).toBeLessThanOrEqual(1000);
      const cardCount = await db
        .prepare('SELECT COUNT(*) AS n FROM catalog_cards')
        .first<{ n: number }>();
      console.warn(
        `100k build: products=${cardCount?.n} invocations=${invocations} maxKvOpsPerInvocation=${kv.maxInvocationOps} ms=${Date.now() - buildStart}`
      );
      expect(cardCount?.n).toBe(100_000);
      // Collection listings published at scale too.
      const manual = await readListingPage(db, kv, 'cmanual', 1);
      expect(manual?.total).toBe(3);
      const rule = await readListingPage(db, kv, 'crule', 1);
      expect(rule?.total).toBe(rows.filter((r) => r.slug.includes('bulk-1')).length);

      const first = await readListingPage(db, kv, ALL_LISTING, 1);
      expect(first?.total).toBe(100_000);
      expect(first?.pageCount).toBe(4167);
      expect(first?.cards).toHaveLength(24);
      const last = await readListingPage(db, kv, ALL_LISTING, 4167);
      expect(last?.cards).toHaveLength(16);

      // No value approaches the 25 MiB KV limit; nothing holds the
      // whole catalogue in one value.
      let maxValue = 0;
      for (const v of kv.map.values()) maxValue = Math.max(maxValue, v.length);
      console.warn(`100k max KV value bytes: ${maxValue}`);
      expect(maxValue).toBeLessThan(128 * 1024);

      // Bootstrap must acknowledge its captured revisions itself.
      const backlog = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM catalog_work WHERE entity_type IN ('product','media','collection','settings') AND processed_revision<target_revision"
        )
        .first<{ n: number }>();
      expect(backlog?.n).toBe(0);

      // A build is done only once every reference it committed is delivered, so the
      // edit's key set below is its own.
      const pending = await db
        .prepare('SELECT COUNT(*) AS n FROM catalog_ref_state WHERE pending_payload IS NOT NULL')
        .first<{ n: number }>();
      expect(pending?.n).toBe(0);

      // A single edit at 100k republishes only its containing pages:
      // page + directory path + reference for `all` and the manual
      // collection holding the product. No catalogue-wide rewrite.
      kv.putKeys = [];
      await db.prepare("UPDATE products SET title='Renamed at scale' WHERE id='bp50000'").run();
      const editStart = Date.now();
      const edit = await queue.deliver();
      expect(edit.retried).toBe(false);
      const work = await db
        .prepare(
          "SELECT processed_revision-target_revision AS lag FROM catalog_work WHERE id='product:bp50000'"
        )
        .first<{ lag: number }>();
      expect(work?.lag).toBe(0);
      const found = await db
        .prepare(
          "SELECT page FROM catalog_page_products WHERE product_id='bp50000' AND listing_id='all' AND generation=(SELECT generation FROM catalog_listings WHERE listing_id='all' AND active=1)"
        )
        .first<{ page: number }>();
      if (!found) throw new Error('edited product is on no active page');
      console.warn(
        `100k single-edit: deliveries=1 d1=${edit.d1} kvOps=${edit.kv} ms=${Date.now() - editStart} puts(${kv.putKeys.length})=${JSON.stringify(kv.putKeys)}`
      );
      const normalized = (key: string) => key.replace(/:[0-9a-f]{16}$/, ':#');
      expect(kv.putKeys.map(normalized).sort()).toEqual(
        [
          'catalog:r1:product:bp50000:#',
          'catalog:r1:slug:product:bulk-50000',
          `catalog:r1:listing:all:page:${found.page}:#`,
          'catalog:r1:dir:#',
          'catalog:r1:dir:#',
          'catalog:r1:listing:all:current',
          'catalog:r1:listing:cmanual:page:1:#',
          'catalog:r1:dir:#',
          'catalog:r1:listing:cmanual:current',
        ].sort()
      );
      const page = await readListingPage(db, kv, ALL_LISTING, found.page);
      expect(page?.cards.some((c) => c.title === 'Renamed at scale')).toBe(true);

      // A clean queue wake-up verifies replicas without allocating a
      // publication or rewriting healthy values. Full-source no-op
      // rebuilds are covered separately by catalog-read-models.
      kv.puts = 0;
      const publicationBefore = await db
        .prepare('SELECT publication_seq FROM catalog_publication_state')
        .first();
      let drained = false;
      for (let unit = 0; unit < 10000; unit++) {
        const delivery = await queue.deliver();
        expect(delivery.retried).toBe(false);
        if (!delivery.continued) {
          drained = true;
          break;
        }
      }
      expect(drained).toBe(true);
      expect(kv.puts).toBe(0);
      expect(
        await db.prepare('SELECT publication_seq FROM catalog_publication_state').first()
      ).toEqual(publicationBefore);
      console.warn(`100k no-op wake-up puts: ${kv.puts}`);
    } finally {
      await dispose();
    }
  }
);

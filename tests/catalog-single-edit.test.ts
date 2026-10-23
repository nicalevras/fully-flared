import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { catalogQueueHarness } from './helpers/catalog-queue';
import { buildCatalogReadModels } from './helpers/catalog-driver';
import { createTestDb } from './helpers/d1';
import { ARTIFACT_BYTE_LIMIT } from '../web/src/server/catalog-models';

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

class RecordingKv {
  map = new Map<string, string>();
  putKeys: string[] = [];
  deleteKeys: string[] = [];
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.putKeys.push(key);
    this.map.set(key, value);
    if (this.putKeys.length % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  async delete(key: string) {
    this.deleteKeys.push(key);
    this.map.delete(key);
  }
}

// Above one directory node's fan-out, so `all` has a leaf and a root.
const PRODUCTS = 3_200;

async function seed(db: D1Database) {
  const rows = Array.from({ length: PRODUCTS }, (_, i) => ({
    id: `bp${i}`,
    slug: `bulk-${i}`,
    descriptionBytes: 1_000 + (i % 10) * 1_000,
    variants: 3 + (i % 3),
    basePrice: 1_000 + (i % 2) * 10_000,
    created: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
  }));
  for (let s = 0; s < rows.length; s += 400) {
    const json = JSON.stringify(rows.slice(s, s + 400));
    await db.batch([
      db
        .prepare(
          `INSERT INTO products(id,slug,title,description,status,created_at,updated_at)
           SELECT json_extract(value,'$.id'), json_extract(value,'$.slug'), json_extract(value,'$.slug'),
                  hex(randomblob(json_extract(value,'$.descriptionBytes'))), 'active',
                  json_extract(value,'$.created'), json_extract(value,'$.created') FROM json_each(?)`
        )
        .bind(json),
      db
        .prepare(
          `WITH RECURSIVE n(k) AS (SELECT 0 UNION ALL SELECT k+1 FROM n WHERE k<4)
           INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at)
           SELECT 'v' || json_extract(value,'$.id') || '-' || k, json_extract(value,'$.id'),
                  'SKU-' || json_extract(value,'$.id') || '-' || k, 'Size ' || k,
                  json_extract(value,'$.basePrice') + k * 100,
                  'active', json_extract(value,'$.created')
           FROM json_each(?) JOIN n ON n.k < json_extract(value,'$.variants')`
        )
        .bind(json),
      db
        .prepare(
          `INSERT INTO stock(sku,on_hand,reserved,updated_at)
           SELECT sku, 10, 0, created_at FROM variants WHERE product_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`
        )
        .bind(json),
    ]);
  }
  await db.batch([
    db.prepare(
      "INSERT INTO collections(id,slug,title,description,kind,rule_json,created_at) VALUES('cmanual','manual-picks','Manual picks','','manual',NULL,'2026-01-01')"
    ),
    db
      .prepare(
        "INSERT INTO collections(id,slug,title,description,kind,rule_json,created_at) VALUES('crule-title','bulk-ones','Bulk ones','','rule',?, '2026-01-01')"
      )
      .bind(JSON.stringify({ type: 'title_contains', value: 'bulk-1' })),
    db
      .prepare(
        "INSERT INTO collections(id,slug,title,description,kind,rule_json,created_at) VALUES('crule-cheap','cheap','Cheap','','rule',?, '2026-01-01')"
      )
      .bind(JSON.stringify({ type: 'price_lte', value: 5000 })),
    db.prepare(
      "INSERT INTO product_collections(product_id,collection_id) VALUES('bp1','cmanual'),('bp2','cmanual'),('bp2001','cmanual')"
    ),
  ]);
}

const normalized = (key: string) => key.replace(/:[0-9a-f]{16}$/, ':#');

it(
  'publishes one price edit as exactly its own keys in one queue delivery',
  { timeout: 600_000 },
  async () => {
    const { db, dispose } = await createTestDb();
    const kv = new RecordingKv();
    try {
      await seed(db);
      await buildCatalogReadModels(db, kv);
      const queue = await catalogQueueHarness(db, kv);
      let drained = false;
      for (let guard = 0; guard < 2_000 && !drained; guard++) {
        const delivery = await queue.deliver();
        expect(delivery.retried).toBe(false);
        drained = !delivery.continued;
      }
      expect(drained).toBe(true);
      const idle = await db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM catalog_work WHERE processed_revision<target_revision) AS work,
                  (SELECT COUNT(*) FROM catalog_ref_state WHERE pending_payload IS NOT NULL) AS refs`
        )
        .first<{ work: number; refs: number }>();
      expect(idle).toEqual({ work: 0, refs: 0 });
      const generations = `SELECT listing_id,generation FROM catalog_listings WHERE active=1 AND listing_id LIKE 'crule-%' ORDER BY listing_id`;
      const rulesBefore = (await db.prepare(generations).all()).results;
      // The edit's own resumable checkpoint is a `work` row; any other
      // new row would be a broader build.
      const builds =
        "SELECT kind,COUNT(*) AS n FROM catalog_builds WHERE kind<>'work' GROUP BY kind ORDER BY kind";
      const buildsBefore = (await db.prepare(builds).all()).results;
      kv.putKeys = [];
      kv.deleteKeys = [];

      await db.prepare("UPDATE variants SET price_cents=12000 WHERE id='vbp2001-0'").run();
      const delivery = await queue.deliver();

      expect(delivery.retried).toBe(false);
      const work = await db
        .prepare(
          "SELECT processed_revision-target_revision AS lag FROM catalog_work WHERE id='product:bp2001'"
        )
        .first<{ lag: number }>();
      expect(work?.lag).toBe(0);
      const page = await db
        .prepare(
          "SELECT p.page FROM catalog_page_products p JOIN catalog_listings l ON l.listing_id=p.listing_id AND l.generation=p.generation AND l.active=1 WHERE p.listing_id='all' AND p.product_id='bp2001'"
        )
        .first<{ page: number }>();
      expect(kv.putKeys.map(normalized).sort()).toEqual(
        [
          'catalog:r1:product:bp2001:#',
          'catalog:r1:slug:product:bulk-2001',
          `catalog:r1:listing:all:page:${page?.page}:#`,
          'catalog:r1:dir:#',
          'catalog:r1:dir:#',
          'catalog:r1:listing:all:current',
          'catalog:r1:listing:cmanual:page:1:#',
          'catalog:r1:dir:#',
          'catalog:r1:listing:cmanual:current',
        ].sort()
      );
      expect(kv.deleteKeys).toEqual([]);
      expect((await db.prepare(generations).all()).results).toEqual(rulesBefore);
      expect((await db.prepare(builds).all()).results).toEqual(buildsBefore);
      const docKey = kv.putKeys.find((key) => key.startsWith('catalog:r1:product:bp2001:'));
      const doc = docKey ? kv.map.get(docKey) : undefined;
      expect(new TextEncoder().encode(doc ?? '').byteLength).toBeGreaterThan(0);
      expect(new TextEncoder().encode(doc ?? '').byteLength).toBeLessThan(ARTIFACT_BYTE_LIMIT);
    } finally {
      await dispose();
    }
  }
);

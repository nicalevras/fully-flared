import { expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { runCatalogUnit, requestCatalogSourceRebuild } from '../web/src/server/catalog-publisher';
import { readListingPage } from '../web/src/server/catalog-read';
import { CatalogBudget } from '../web/src/server/catalog-exec';
import { ALL_LISTING } from '../web/src/server/catalog-models';

// Historical 0008 page-copy verification is unproven (the migration
// was amended after local application and the table repaired by
// hand). This disposable test closes the Round 2 rebuild
// requirement: derived page data is NOT trusted — a complete rebuild
// through the corrected queue publisher regenerates exact pages
// from source after the derived copies are corrupted and KV lost.

class FakeKv {
  map = new Map<string, string>();
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.map.set(k, v);
  }
  async delete(k: string) {
    this.map.delete(k);
  }
}

it(
  'rebuilds corrupted derived pages exactly through the queue publisher (disposable)',
  { timeout: 180_000 },
  async () => {
    const { db, dispose } = await createTestDb();
    const kv = new FakeKv();
    try {
      for (let i = 0; i < 30; i++) {
        await db.batch([
          db
            .prepare(
              "INSERT INTO products(id,slug,title,description,status,created_at,updated_at) VALUES(?,?,?,'d','active',?,?)"
            )
            .bind(`p${i}`, `s-${i}`, `Title ${i}`, '2026-01-01', '2026-01-01'),
          db
            .prepare(
              "INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) VALUES(?,?,?,?,?,'active',?)"
            )
            .bind(`v${i}`, `p${i}`, `SKU-${i}`, 'D', 100 + i, '2026-01-01'),
          db
            .prepare('INSERT INTO stock(sku,on_hand,reserved,updated_at) VALUES(?,5,0,?)')
            .bind(`SKU-${i}`, '2026-01-01'),
        ]);
      }
      await db.prepare('UPDATE catalog_work SET processed_revision = target_revision').run();
      const drive = async () => {
        for (let g = 0; g < 200; g++) {
          const res = await runCatalogUnit(db, kv, { budget: new CatalogBudget() });
          if (res.done) return;
        }
        throw new Error('did not converge');
      };
      await drive();
      const before = await readListingPage(db, kv, ALL_LISTING, 1);
      expect(before?.cards.map((c) => c.title)).toContain('Title 29');

      // Simulate the untrusted historical copy: corrupt every D1
      // page payload, then lose KV entirely.
      await db
        .prepare(
          'UPDATE catalog_listing_page_revisions SET payload_json = \'{"listingId":"all","generation":1,"page":1,"pageSize":24,"total":0,"pageCount":1,"cards":[]}\''
        )
        .run();
      kv.map.clear();

      // Damaged D1 derived data requires an explicit source rebuild;
      // ordinary KV repair must never regenerate from live source.
      await requestCatalogSourceRebuild(db);

      await drive();
      const after = await readListingPage(db, kv, ALL_LISTING, 1);
      expect(after?.total).toBe(30);
      expect(after?.cards.map((c) => c.title)).toEqual(before?.cards.map((c) => c.title));
      // D1 derived payload regenerated exactly, not trusted.
      const row = await db
        .prepare(
          'SELECT payload_json FROM catalog_listing_page_revisions WHERE listing_id = ? AND generation = ? AND page = 1 ORDER BY created_at DESC LIMIT 1'
        )
        .bind(ALL_LISTING, after!.generation)
        .first<{ payload_json: string }>();
      expect(JSON.parse(row!.payload_json).cards.map((c: { title: string }) => c.title)).toEqual(
        before?.cards.map((c) => c.title)
      );
    } finally {
      await dispose();
    }
  }
);

import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { runCatalogUnit as productionUnit } from '../web/src/server/catalog-publisher';
import { CatalogBudget } from '../web/src/server/catalog-exec';
import { catalogQueueHarness } from './helpers/catalog-queue';
import { contentRevision, directoryKey, listingRefKey } from '../web/src/server/catalog-models';
// Advance only Date between deliveries; actual D1 I/O and budget assertions remain real.
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());
async function runCatalogUnit(...args: Parameters<typeof productionUnit>) {
  vi.setSystemTime(Date.now() + 2000);
  const result = await productionUnit(...args);
  if (result.retryAfterSeconds) vi.setSystemTime(Date.now() + result.retryAfterSeconds * 1000);
  return result;
}
class Kv {
  map = new Map<string, string>();
  putKeys: string[] = [];
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.putKeys.push(k);
    this.map.set(k, v);
  }
  async delete(k: string) {
    this.map.delete(k);
  }
}
it(
  '48-product collection pages checkpoint within the physical statement budget',
  { timeout: 180_000 },
  async () => {
    const { db, dispose } = await createTestDb();
    const kv = new Kv();
    try {
      const ids = JSON.stringify(Array.from({ length: 400 }, (_, i) => `rule-page-${i}`));
      await db.batch([
        db
          .prepare(
            "INSERT INTO products(id,slug,title,status,created_at,updated_at) SELECT value,value,value,'active','2026-01-01','2026-01-01' FROM json_each(?)"
          )
          .bind(ids),
        db
          .prepare(
            "INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) SELECT 'v-'||value,value,'s-'||value,'D',100,'active','2026-01-01' FROM json_each(?)"
          )
          .bind(ids),
        db
          .prepare(
            "INSERT INTO collections(id,slug,title,kind,rule_json,created_at) VALUES('wide-rule','wide-rule','All 400','rule',?, '2026-01-01')"
          )
          .bind(JSON.stringify({ type: 'title_contains', value: 'rule-page-' })),
      ]);
      const queue = await catalogQueueHarness(db, kv);
      let previous = '',
        stagnant = 0,
        done = false;
      for (let unit = 0; unit < 300; unit++) {
        const delivery = await queue.deliver();
        expect(delivery.retried).toBe(false);
        const build = await db
          .prepare(
            "SELECT state,phase,state_json FROM catalog_builds WHERE kind='full' ORDER BY created_at DESC LIMIT 1"
          )
          .first<{ state: string; phase: string; state_json: string }>();
        if (unit % 50 === 0)
          process.stdout.write(`catalog checkpoint unit=${unit} phase=${build?.phase}\n`);
        if (build?.state === 'done') {
          done = true;
          break;
        }
        if (build?.phase === 'pages') {
          const state = JSON.parse(build.state_json) as { li: number; nextPage: number };
          const cursor = `${state.li}:${state.nextPage}`;
          stagnant = cursor === previous ? stagnant + 1 : 0;
          expect(stagnant, `listing page checkpoint stuck at ${cursor}`).toBeLessThan(6);
          previous = cursor;
        }
      }
      expect(done).toBe(true);
      const listing = await db
        .prepare(
          "SELECT total,page_count FROM catalog_listings WHERE listing_id='wide-rule' AND active=1"
        )
        .first();
      expect(listing).toEqual({ total: 400, page_count: 9 });
      // Give this small fixture the same two-level directory path as
      // the 100k catalog, without rebuilding 100k products to diagnose it.
      const ref = JSON.parse(kv.map.get(listingRefKey('all'))!) as { rootHash: string };
      const payload = JSON.stringify({
        kind: 'index',
        entries: [{ from: 1, to: 17, hash: ref.rootHash }],
      });
      const root = contentRevision(payload);
      await db.batch([
        db
          .prepare(
            "INSERT INTO catalog_ref_chunks(hash,listing_id,payload_json,created_at) VALUES(?,'all',?,datetime('now'))"
          )
          .bind(root, payload),
        db
          .prepare("UPDATE catalog_ref_state SET root_hash=? WHERE ref_key='listing:all'")
          .bind(root),
        db
          .prepare("UPDATE catalog_listing_ref_history SET root_hash=? WHERE listing_id='all'")
          .bind(root),
      ]);
      kv.map.set(directoryKey(root), payload);
      kv.map.set(listingRefKey('all'), JSON.stringify({ ...ref, rootHash: root }));
      kv.putKeys = [];
      await db
        .prepare("UPDATE products SET title='rule-page-renamed' WHERE id='rule-page-250'")
        .run();
      let processed = false;
      for (let unit = 0; unit < 30; unit++) {
        const delivery = await queue.deliver();
        expect(delivery.retried).toBe(false);
        const work = await db
          .prepare(
            "SELECT processed_revision,target_revision FROM catalog_work WHERE id='product:rule-page-250'"
          )
          .first<{ processed_revision: number; target_revision: number }>();
        if (work?.processed_revision === work?.target_revision) {
          processed = true;
          break;
        }
      }
      expect(processed).toBe(true);
      expect(kv.putKeys.length).toBeLessThanOrEqual(10);
      // Membership changes must rebuild the complete listing in bounded
      // units, rather than publishing a truncated membership probe.
      await db.prepare("UPDATE products SET status='archived' WHERE id='rule-page-249'").run();
      let resized = false;
      for (let unit = 0; unit < 200; unit++) {
        const delivery = await queue.deliver();
        expect(delivery.retried).toBe(false);
        const listings = await db
          .prepare(
            "SELECT listing_id,total FROM catalog_listings WHERE active=1 AND listing_id IN ('all','wide-rule') ORDER BY listing_id"
          )
          .all<{ listing_id: string; total: number }>();
        if (listings.results.length === 2 && listings.results.every((row) => row.total === 399)) {
          resized = true;
          break;
        }
      }
      expect(resized).toBe(true);
    } finally {
      await dispose();
    }
  }
);
it('repairs a large accepted editorial artifact without materializing its old KV value', async () => {
  const { db, dispose } = await createTestDb();
  const kv = new Kv();
  try {
    await seedProduct(db);
    await drive(db, kv);
    const payload = JSON.stringify({
      kind: 'post',
      slug: 'large',
      contentHtml: '€'.repeat(400000),
    });
    await db
      .prepare(
        "INSERT INTO catalog_documents(key,kind,revision,payload_json,updated_at) VALUES('large-editorial','editorial','r',?,datetime('now'))"
      )
      .bind(payload)
      .run();
    kv.map.set('large-editorial', 'x'.repeat(1200000));
    await drive(db, kv, 70, 'replica');
    expect(kv.map.has('large-editorial')).toBe(true);
    expect(contentRevision(kv.map.get('large-editorial')!)).toBe(contentRevision(payload));
  } finally {
    await dispose();
  }
});
it('persisted media fanout must not strand the production unit dispatcher', async () => {
  const { db, dispose } = await createTestDb();
  const kv = new Kv();
  try {
    await drive(db, kv);
    const ids = JSON.stringify(Array.from({ length: 91 }, (_, i) => 'fp' + i));
    await db.batch([
      db
        .prepare(
          "INSERT INTO products(id,slug,title,description,status,created_at,updated_at) SELECT value,value,value,'','active','2026-01-01','2026-01-01' FROM json_each(?)"
        )
        .bind(ids),
      db
        .prepare(
          "INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) SELECT 'v-'||value,value,'sku-'||value,'D',100,'active','2026-01-01' FROM json_each(?)"
        )
        .bind(ids),
      db.prepare(
        "INSERT INTO media(id,r2_key,filename,content_type,alt_text,created_at) VALUES('fm','fm.jpg','fm.jpg','image/jpeg','','2026-01-01')"
      ),
      db
        .prepare(
          "INSERT INTO product_media(product_id,media_id,position) SELECT value,'fm',0 FROM json_each(?)"
        )
        .bind(ids),
    ]);
    await db.prepare('UPDATE catalog_work SET processed_revision=target_revision').run();
    await db.prepare("UPDATE media SET r2_key='new.jpg' WHERE id='fm'").run();
    await runCatalogUnit(db, kv, { budget: new CatalogBudget() });
    for (let i = 0; i < 3; i++) await runCatalogUnit(db, kv, { budget: new CatalogBudget() });
    const open = await db
      .prepare(
        "SELECT kind,phase,state FROM catalog_builds WHERE kind='fanout' AND state='building'"
      )
      .all();
    expect(open.results).toEqual([]);
  } finally {
    await dispose();
  }
});
it('50 due edits must advance at least one work item in five production units', async () => {
  const { db, dispose } = await createTestDb();
  const kv = new Kv();
  try {
    await drive(db, kv);
    for (let i = 0; i < 50; i++)
      await db
        .prepare(
          "INSERT INTO pages(id,slug,title,content_html,created_at,updated_at) VALUES(?,?,?,'body','2026-01-01','2026-01-01')"
        )
        .bind('due' + i, 'due' + i, 'Due ' + i)
        .run();
    for (let i = 0; i < 5; i++) await runCatalogUnit(db, kv, { budget: new CatalogBudget() });
    const r = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM catalog_work WHERE entity_type='page' AND processed_revision=target_revision"
      )
      .first<{ n: number }>();
    expect(r?.n).toBeGreaterThan(0);
  } finally {
    await dispose();
  }
});
it('KV loss repair must preserve committed publication identity despite changed source', async () => {
  const { db, dispose } = await createTestDb();
  const kv = new Kv();
  try {
    await seedProduct(db);
    await db.prepare('UPDATE catalog_work SET processed_revision=target_revision').run();
    await drive(db, kv);
    const old = await db.prepare('SELECT publication_seq FROM catalog_publication_state').first();
    await db.prepare("UPDATE products SET title='UNPUBLISHED CHANGE' WHERE id='p1'").run();
    await db.prepare('UPDATE catalog_work SET processed_revision=target_revision').run();
    kv.map.clear();
    await drive(db, kv);
    const current = await db
      .prepare('SELECT publication_seq FROM catalog_publication_state')
      .first();
    expect(current).toEqual(old);
    expect([...kv.map.values()].some((v) => v.includes('UNPUBLISHED CHANGE'))).toBe(false);
  } finally {
    await dispose();
  }
});
async function drive(db: D1Database, kv: Kv, n = 70, maintenance?: 'replica') {
  for (let i = 0; i < n; i++) {
    const r = await runCatalogUnit(db, kv, { budget: new CatalogBudget(), maintenance });
    if (r.done) return i + 1;
  }
  throw Error(
    'Did not converge after ' +
      n +
      ' units; ' +
      JSON.stringify(
        (await db.prepare("SELECT kind,phase,state FROM catalog_builds WHERE state!='done'").all())
          .results
      )
  );
}
it('40 editorial pages must complete through bounded production units', async () => {
  const { db, dispose } = await createTestDb();
  const kv = new Kv();
  try {
    for (let i = 0; i < 40; i++)
      await db
        .prepare(
          "INSERT INTO pages(id,slug,title,content_html,created_at,updated_at) VALUES(?,?,?,'body','2026-01-01','2026-01-01')"
        )
        .bind('pg' + i, 'pg' + i, 'Page ' + i)
        .run();
    await db.prepare('UPDATE catalog_work SET processed_revision=target_revision').run();
    await drive(db, kv, 70);
  } finally {
    await dispose();
  }
});
it('10 collections must activate through bounded production units', async () => {
  const { db, dispose } = await createTestDb();
  const kv = new Kv();
  try {
    for (let i = 0; i < 10; i++)
      await db
        .prepare(
          "INSERT INTO collections(id,slug,title,kind,created_at) VALUES(?,?,?,'manual','2026-01-01')"
        )
        .bind('c' + i, 'c' + i, 'Collection ' + i)
        .run();
    await db.prepare('UPDATE catalog_work SET processed_revision=target_revision').run();
    await drive(db, kv, 80);
  } finally {
    await dispose();
  }
});
it('partial KV loss repairs a missing product document while listing ref survives', async () => {
  const { db, dispose } = await createTestDb();
  const kv = new Kv();
  try {
    await seedProduct(db);
    await db.prepare('UPDATE catalog_work SET processed_revision=target_revision').run();
    await drive(db, kv);
    const k = [...kv.map.keys()].find(
      (k) => k.startsWith('catalog:r1:product:') && !k.includes('slug')
    );
    expect(k).toBeTruthy();
    kv.map.delete(k!);
    await drive(db, kv, 70, 'replica');
    expect(kv.map.has(k!)).toBe(true);
  } finally {
    await dispose();
  }
});
it('delivered mutable reference is verified after a stale overwrite', async () => {
  const { db, dispose } = await createTestDb();
  const kv = new Kv();
  try {
    await seedProduct(db);
    await db.prepare('UPDATE catalog_work SET processed_revision=target_revision').run();
    await drive(db, kv);
    const k = [...kv.map.keys()].find((k) => k.includes('listing') && k.endsWith(':current'));
    expect(k).toBeTruthy();
    const exact = kv.map.get(k!)!;
    kv.map.set(k!, exact.replace('"total":1', '"total":999'));
    await drive(db, kv, 70, 'replica');
    expect(kv.map.get(k!)).toBe(exact);
  } finally {
    await dispose();
  }
});

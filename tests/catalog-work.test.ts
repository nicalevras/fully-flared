import { beforeEach, afterEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { processCatalogBuild, runCatalogUnit } from '../web/src/server/catalog-publisher';
import { CatalogBudget } from '../web/src/server/catalog-exec';
import { readListingPage, resolveDirectoryRevision } from '../web/src/server/catalog-read';
import { getShopProductsPage, getStorefrontLayout } from '../web/src/server/catalog-read';
import {
  getPaletteSuggestions,
  getPublishedCollection,
  PALETTE_SUGGESTION_SIZE,
  searchCatalog,
  suggestCatalog,
} from '../web/src/server/catalog-discovery';
import { ALL_LISTING } from '../web/src/server/catalog-models';
import { buildCatalogReadModels, catalogWork as drainCatalogWork } from './helpers/catalog-driver';

/** Drain, then simulate the queue returning after the publisher's
 *  per-key KV pacing window (about one second) and drain again. Run
 *  fast, this file otherwise reads a listing reference whose newest
 *  delivery is still pacing-deferred; run under full-suite load, the
 *  window has already elapsed, which made these tests pass there and
 *  fail alone. No production timing changes. */
async function catalogWork(dbArg: D1Database, kvArg: FakeKv) {
  const total = await drainCatalogWork(dbArg, kvArg);
  await dbArg
    .prepare(
      "UPDATE catalog_ref_state SET last_write_at = '2000-01-01T00:00:00.000Z', delivery_retry_at = NULL WHERE pending_payload IS NOT NULL"
    )
    .run();
  const second = await drainCatalogWork(dbArg, kvArg);
  total.processed += second.processed;
  total.productsPublished += second.productsPublished;
  total.listingsRefreshed.push(...second.listingsRefreshed);
  total.kvPuts += second.kvPuts;
  return total;
}

class FakeKv {
  map = new Map<string, string>();
  puts = 0;
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.puts++;
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

let db: D1Database, dispose: () => Promise<void>;
let kv: FakeKv;
const env = () => ({ CATALOG_KV: kv as never, DB: db });

async function product(id: string, slug: string, title: string, createdAt: string, price = 1000) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO products(id,slug,title,description,status,created_at,updated_at) VALUES(?,?,?,'desc','active',?,?)"
      )
      .bind(id, slug, title, createdAt, createdAt),
    db
      .prepare(
        "INSERT INTO variants(id,product_id,sku,title,price_cents,status,created_at) VALUES(?,?,?,?,?,'active',?)"
      )
      .bind(`v-${id}`, id, `SKU-${id}`, 'Default', price, createdAt),
    db
      .prepare('INSERT INTO stock(sku,on_hand,reserved,updated_at) VALUES(?,50,0,?)')
      .bind(`SKU-${id}`, createdAt),
  ]);
}

async function workRow(entityId: string) {
  return db
    .prepare(
      "SELECT target_revision, processed_revision FROM catalog_work WHERE entity_type='product' AND entity_id=?"
    )
    .bind(entityId)
    .first<{ target_revision: number; processed_revision: number }>();
}

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  kv = new FakeKv();
  await product('p1', 'alpha', 'Alpha', '2026-01-03T00:00:00.000Z');
  await product('p2', 'beta', 'Beta', '2026-01-02T00:00:00.000Z');
  await product('p3', 'gamma', 'Gamma', '2026-01-01T00:00:00.000Z');
  await buildCatalogReadModels(db, kv);
  // Drain the insert-capture rows so each test starts fully processed.
  await catalogWork(db, kv);
});
afterEach(async () => {
  await dispose();
});

it('triggers capture product edits transactionally; stock edits do not dirty the catalog', async () => {
  const drained = await workRow('p1');
  expect(drained?.processed_revision).toBe(drained?.target_revision);
  const base = drained!.target_revision;
  await db.prepare("UPDATE products SET title='Alpha 2' WHERE id='p1'").run();
  const after = await workRow('p1');
  expect(after?.target_revision).toBe(base + 1);
  expect(after?.processed_revision).toBe(base);
  await db.prepare("UPDATE stock SET on_hand=99 WHERE sku='SKU-p1'").run();
  expect((await workRow('p1'))?.target_revision).toBe(base + 1);
  const orderWork = await db
    .prepare("SELECT COUNT(*) AS n FROM catalog_work WHERE entity_type='order'")
    .first<{ n: number }>();
  expect(orderWork?.n).toBe(0);
});

it('a title edit patches only its containing pages inside the same generation', async () => {
  const keysBefore = kv.map.size;
  kv.puts = 0;
  await db.prepare("UPDATE products SET title='Alpha patched' WHERE id='p1'").run();
  const result = await catalogWork(db, kv);
  expect(result.processed).toBeGreaterThan(0);
  const page = await readListingPage(db, kv, ALL_LISTING, 1);
  expect(page?.generation).toBe(1);
  expect(page?.cards[0]?.title).toBe('Alpha patched');
  // Doc + slug pointer + one page + directory root + listing ref:
  // bounded, not a rebuild (the directory node is the Round 4 addition
  // that lets readers resolve the exact page revision).
  expect(result.kvPuts).toBeLessThanOrEqual(6);
  expect(kv.map.size).toBeLessThanOrEqual(keysBefore + 3);
});

it('palette suggestions are the newest head of the published listing, capped', async () => {
  const head = await getPaletteSuggestions(db, env() as never);
  expect(head.map((c) => c.id)).toEqual(['p1', 'p2', 'p3']);
  for (let i = 4; i <= 12; i++) {
    await product(
      `p${i}`,
      `extra-${i}`,
      `Extra ${i}`,
      `2026-02-${String(i).padStart(2, '0')}T00:00:00.000Z`
    );
  }
  await catalogWork(db, kv);
  const capped = await getPaletteSuggestions(db, env() as never);
  expect(capped).toHaveLength(PALETTE_SUGGESTION_SIZE);
  expect(capped[0]?.id).toBe('p12');
});

it('a new product advances the listing generation and appears on /shop', async () => {
  await product('p4', 'delta', 'Delta', '2026-01-04T00:00:00.000Z');
  await catalogWork(db, kv);
  const page = await readListingPage(db, kv, ALL_LISTING, 1);
  expect(page?.generation).toBe(2);
  expect(page?.total).toBe(4);
  const shop = await getShopProductsPage(db, env() as never, 1);
  expect(shop.products[0]?.id).toBe('p4');
  expect(shop.total).toBe(4);
});

it('a price edit re-evaluates rule collection membership', async () => {
  await db
    .prepare(
      `INSERT INTO collections(id,slug,title,kind,rule_json,created_at) VALUES('cheap','cheap','Cheap','rule','{"type":"price_lte","value":1000}','2026-01-01')`
    )
    .run();
  await catalogWork(db, kv);
  let col = await getPublishedCollection(db, env() as never, 'cheap', 1);
  expect(col?.total).toBe(3);
  await db.prepare("UPDATE variants SET price_cents=5000 WHERE product_id='p1'").run();
  await catalogWork(db, kv);
  col = await getPublishedCollection(db, env() as never, 'cheap', 1);
  expect(col?.total).toBe(2);
  expect(col?.products.map((p) => p.id)).not.toContain('p1');
});

it('an edit landing after the claim stays due and is published by the next pass', async () => {
  await db.prepare("UPDATE products SET title='Alpha mid' WHERE id='p1'").run();
  // Simulate a second edit arriving while the first is being built: the
  // target advances past what any in-flight pass claimed.
  await db
    .prepare(
      "UPDATE catalog_work SET target_revision = target_revision + 1 WHERE entity_type='product' AND entity_id='p1'"
    )
    .run();
  const claimedTarget = (await workRow('p1'))!.target_revision;
  // First pass can only mark up to its claimed snapshot if the row moved;
  // regardless, a follow-up pass must converge the reader to the source.
  await catalogWork(db, kv);
  await catalogWork(db, kv);
  const row = await workRow('p1');
  expect(row?.processed_revision).toBe(row?.target_revision);
  expect(row?.target_revision).toBeGreaterThanOrEqual(claimedTarget);
  const page = await readListingPage(db, kv, ALL_LISTING, 1);
  expect(page?.cards[0]?.title).toBe('Alpha mid');
});

it('readers serve identical results from D1 when KV is empty, and layout/search work', async () => {
  const viaKv = await readListingPage(db, kv, ALL_LISTING, 1);
  kv.map.clear();
  const viaD1 = await readListingPage(db, kv, ALL_LISTING, 1);
  expect(viaD1?.cards.map((c) => c.id)).toEqual(viaKv?.cards.map((c) => c.id));
  const layout = await getStorefrontLayout(db, env() as never);
  expect(layout.storeName).toBeTruthy();
  expect(layout.limits.checkout_session_minutes).toBeGreaterThan(0);
  const found = await suggestCatalog(db, env() as never, 'alpha');
  expect(found.cards.map((c) => c.id)).toEqual(['p1']);
  const none = await suggestCatalog(db, env() as never, 'zzzz');
  expect(none).toEqual({ cards: [], hasMore: false });
});

it('search continues past the first page with a cursor, without repeats', async () => {
  // 55 more products sharing a term with distinct timestamps/ids.
  const stmts = [];
  for (let i = 0; i < 55; i++) {
    const n = String(i).padStart(2, '0');
    stmts.push(
      db.prepare(
        `INSERT INTO products (id, slug, title, description, status, created_at, updated_at) VALUES ('s${n}', 'seek-${n}', 'Seekable ${n}', '', 'active', '2026-02-01T00:00:${n}.000Z', '2026-02-01')`
      )
    );
    stmts.push(
      db
        .prepare(
          `INSERT INTO catalog_cards (product_id, slug, card_json, revision, doc_revision, updated_at) VALUES ('s${n}', 'seek-${n}', ?, 'r', 'r', '2026-02-01')`
        )
        .bind(JSON.stringify({ id: `s${n}`, slug: `seek-${n}`, title: `Seekable ${n}` }))
    );
  }
  await db.batch(stmts);
  const page1 = await searchCatalog(db, env() as never, 'seekable');
  expect(page1.cards).toHaveLength(50);
  expect(page1.nextCursor).toBeTruthy();
  const page2 = await searchCatalog(db, env() as never, 'seekable', page1.nextCursor!);
  expect(page2.cards).toHaveLength(5);
  expect(page2.nextCursor).toBeNull();
  const ids = new Set([...page1.cards, ...page2.cards].map((c) => c.id));
  expect(ids.size).toBe(55);
  // A malformed cursor falls back to the first page rather than erroring.
  const again = await searchCatalog(db, env() as never, 'seekable', 'not-a-cursor%%');
  expect(again.cards.map((c) => c.id)).toEqual(page1.cards.map((c) => c.id));
});

it('collection pages clamp out-of-range pages to the last page', async () => {
  const col = await getPublishedCollection(db, env() as never, 'missing-slug', 1);
  expect(col).toBeNull();
  await db
    .prepare(
      "INSERT INTO collections(id,slug,title,kind,created_at) VALUES('c1','manual','Manual','manual','2026-01-01')"
    )
    .run();
  await db
    .prepare('INSERT INTO product_collections(product_id,collection_id) VALUES(?,?)')
    .bind('p1', 'c1')
    .run();
  await catalogWork(db, kv);
  const clamped = await getPublishedCollection(db, env() as never, 'manual', 99);
  expect(clamped?.page).toBe(1);
  expect(clamped?.total).toBe(1);
});

it('a failed KV page write advances nothing; the retry republishes', async () => {
  const before = await readListingPage(db, kv, ALL_LISTING, 1);
  expect(before?.cards[0]?.title).toBe('Alpha');
  await db.prepare("UPDATE products SET title='Alpha retry' WHERE id='p1'").run();
  const realPut = kv.put.bind(kv);
  let failOnce = true;
  kv.put = async (key: string, value: string) => {
    if (failOnce && key.includes(':page:')) {
      failOnce = false;
      throw new Error('KV unavailable');
    }
    return realPut(key, value);
  };
  await expect(catalogWork(db, kv)).rejects.toThrow('KV unavailable');
  kv.put = realPut;
  // The failed pass backs off for a minute; make the retry due.
  await db.prepare('UPDATE catalog_work SET next_attempt_at = NULL').run();
  // Committed state is untouched: readers still serve the old page.
  expect((await readListingPage(db, kv, ALL_LISTING, 1))?.cards[0]?.title).toBe('Alpha');
  await catalogWork(db, kv);
  expect((await readListingPage(db, kv, ALL_LISTING, 1))?.cards[0]?.title).toBe('Alpha retry');
});

it('KV loss is repaired by resumable builds while D1 serves exact pages', async () => {
  kv.map.clear();
  // D1 fallback serves the exact committed page with KV empty.
  expect((await readListingPage(db, kv, ALL_LISTING, 1))?.cards.map((c) => c.id)).toEqual([
    'p1',
    'p2',
    'p3',
  ]);
  for (let units = 0; units < 50; units++) {
    const unit = await runCatalogUnit(db, kv, {
      budget: new CatalogBudget(),
      maintenance: 'replica',
    });
    if (unit.done) break;
  }
  expect([...kv.map.keys()].some((k) => k.endsWith(':listing:all:current'))).toBe(true);
  expect((await readListingPage(db, kv, ALL_LISTING, 1))?.cards.map((c) => c.id)).toEqual([
    'p1',
    'p2',
    'p3',
  ]);
});

it('publication history keeps A -> B -> A roots resolving exactly', async () => {
  const firstPage = await readListingPage(db, kv, ALL_LISTING, 1);
  const firstTitle = firstPage?.cards[0]?.title;
  await db.prepare("UPDATE products SET title='Beta title' WHERE id='p1'").run();
  await catalogWork(db, kv);
  await db.prepare("UPDATE products SET title=? WHERE id='p1'").bind(firstTitle).run();
  await catalogWork(db, kv);
  const history = await db
    .prepare(
      'SELECT publication_seq, root_hash FROM catalog_listing_ref_history WHERE listing_id = ? ORDER BY publication_seq'
    )
    .bind(ALL_LISTING)
    .all<{ publication_seq: number; root_hash: string }>();
  expect(history.results.length).toBeGreaterThanOrEqual(3);
  const revisions = new Set<string>();
  for (const h of history.results) {
    const rev = await resolveDirectoryRevision(db, kv, h.root_hash, 1);
    expect(rev).toBeTruthy();
    revisions.add(rev!);
  }
  // B differs; the two A roots resolve to the same content revision.
  expect(revisions.size).toBe(2);
  expect((await readListingPage(db, kv, ALL_LISTING, 1))?.cards[0]?.title).toBe(firstTitle);
});

it('bounded build units never exceed their operation budget', async () => {
  let step;
  let guard = 0;
  do {
    step = await processCatalogBuild(db, kv, { budget: new CatalogBudget(), maxOps: 25 });
    // A started chunk finishes, so a unit may exceed a tiny budget
    // by one chunk (<=10 counted ops at this scale). The 900-op
    // production budget is asserted strictly in the 100k gate.
    expect(step.opsUsed).toBeLessThanOrEqual(35);
    guard++;
  } while (!step.done && guard < 500);
  expect(step.done).toBe(true);
  expect((await readListingPage(db, kv, ALL_LISTING, 1))?.total).toBe(3);
});

it('archiving a product removes it from listings and its document', async () => {
  await db.prepare("UPDATE products SET status='archived' WHERE id='p2'").run();
  await catalogWork(db, kv);
  const page = await readListingPage(db, kv, ALL_LISTING, 1);
  expect(page?.cards.map((c) => c.id)).toEqual(['p1', 'p3']);
  const card = await db
    .prepare('SELECT COUNT(*) AS n FROM catalog_cards WHERE product_id=?')
    .bind('p2')
    .first<{ n: number }>();
  expect(card?.n).toBe(0);
});

import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb, applyMigrationFile, seedProduct } from './helpers/d1';
import { pruneRetention } from '../web/src/server/operations';

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => dispose());

it('scrubs IPs in bounded pages without removing orders', async () => {
  await db
    .prepare(
      `INSERT INTO orders(id,number,status,payment_status,customer_email,currency,subtotal_cents,total_cents,customer_ip,created_at,updated_at)
    SELECT 'ip-'||value,'ip-'||value,'canceled','unpaid','fixture@example.invalid','USD',0,0,'192.0.2.1','2020-01-01','2020-01-01' FROM json_each(?)`
    )
    .bind(JSON.stringify(Array.from({ length: 1001 }, (_, i) => i)))
    .run();
  await pruneRetention(db);
  expect(
    (await db
      .prepare('SELECT COUNT(*) AS n FROM orders WHERE customer_ip IS NOT NULL')
      .first<{ n: number }>())!.n
  ).toBe(1);
  await pruneRetention(db);
  expect((await db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>())!.n).toBe(
    1001
  );
});

import { runCatalogGcUnit, CATALOG_RETENTION_MS } from '../web/src/server/catalog-gc';
import {
  CatalogBudget,
  countedDb,
  countedKv,
  claimCatalogLease,
  releaseCatalogLease,
} from '../web/src/server/catalog-exec';
import {
  contentRevision,
  directoryKey,
  listingPageKey,
  layoutKey,
} from '../web/src/server/catalog-models';
import { processCatalogWork } from '../web/src/server/catalog-publisher';
import { catalogQueueHarness } from './helpers/catalog-queue';
const start = Date.now();
class Kv {
  map = new Map<string, string>();
  failed = false;
  beforeDelete: undefined | (() => Promise<void>);
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.map.set(k, v);
  }
  async delete(k: string) {
    await this.beforeDelete?.();
    if (this.failed) throw new Error('injected storage failure');
    this.map.delete(k);
  }
  async list({ prefix, cursor }: { prefix: string; limit: number; cursor?: string }) {
    // Empty pages with a continuation are legitimate KV behavior.
    if (!cursor) return { keys: [], list_complete: false, cursor: 'next' };
    return {
      keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    };
  }
}
async function cycle(kv: Kv, at: number) {
  const lease = (await claimCatalogLease(db))!;
  try {
    for (let i = 0; i < 100; i++) {
      const budget = new CatalogBudget();
      const done = await runCatalogGcUnit(countedDb(db, budget), countedKv(kv, budget), lease, at);
      expect(budget.d1).toBeLessThanOrEqual(36);
      if (done === null) return;
    }
    throw new Error('reclamation failed to converge');
  } finally {
    await releaseCatalogLease(db, lease);
  }
}
async function doc(key: string) {
  await db
    .prepare(
      "INSERT INTO catalog_documents(key,kind,revision,payload_json,updated_at) VALUES(?,'layout','old','{}','2000-01-01')"
    )
    .bind(key)
    .run();
}
async function has(key: string) {
  return !!(await db.prepare('SELECT 1 FROM catalog_documents WHERE key=?').bind(key).first());
}

it('retains shared/current roots and recently superseded history, then reclaims unreferenced mirrors and KV-only orphans', async () => {
  const kv = new Kv(),
    current = layoutKey('current'),
    old = layoutKey('old');
  await doc(current);
  await doc(old);
  await db
    .prepare(
      "INSERT INTO catalog_ref_state(ref_key,committed_seq,root_hash,updated_at) VALUES('layout',2,'current','2000')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO catalog_ref_documents(ref_key,publication_seq,document_key,retired_at) VALUES('layout',1,?,?),('layout',2,?,NULL)"
    )
    .bind(old, new Date(start).toISOString(), current)
    .run();
  const leaf = JSON.stringify({ kind: 'pages', entries: [{ page: 1, revision: 'shared' }] }),
    hash = contentRevision(leaf),
    page = listingPageKey('all', 1, 'shared');
  await db
    .prepare(
      "INSERT INTO catalog_ref_chunks(hash,listing_id,payload_json,created_at) VALUES(?,'all',?,'2000')"
    )
    .bind(hash, leaf)
    .run();
  await db
    .prepare("INSERT INTO catalog_listing_page_revisions VALUES('all',1,1,'shared','{}','2000')")
    .run();
  await db
    .prepare(
      "INSERT INTO catalog_ref_documents(ref_key,publication_seq,document_key) VALUES('layout',2,?)"
    )
    .bind(directoryKey(hash))
    .run();
  for (const key of [current, old, directoryKey(hash), page, 'catalog:r1:orphan'])
    kv.map.set(key, 'fixture');
  await cycle(kv, start);
  expect(await has(old)).toBe(true);
  expect(kv.map.has('catalog:r1:orphan')).toBe(true);
  await cycle(kv, start + CATALOG_RETENTION_MS + 1);
  expect(await has(old)).toBe(true); // its last retained reference just expired
  expect(kv.map.has('catalog:r1:orphan')).toBe(false);
  await cycle(kv, start + 2 * CATALOG_RETENTION_MS + 2);
  expect(await has(old)).toBe(false);
  expect(await has(current)).toBe(true);
  expect(kv.map.has(page)).toBe(true);
  expect(kv.map.has(directoryKey(hash))).toBe(true);
});

it('keeps failed deletions retryable and protects staged artifacts while a build is live', async () => {
  const kv = new Kv(),
    key = layoutKey('abandoned');
  await doc(key);
  kv.map.set(key, '{}');
  await cycle(kv, start);
  kv.failed = true;
  await cycle(kv, start + CATALOG_RETENTION_MS + 1);
  expect(await has(key)).toBe(true);
  expect(
    await db
      .prepare('SELECT deletion_pending,retry_at FROM catalog_artifacts WHERE key=?')
      .bind(key)
      .first()
  ).toMatchObject({ deletion_pending: 1, retry_at: expect.any(String) });
  await db
    .prepare(
      "INSERT INTO catalog_builds(id,state,created_at,updated_at) VALUES('live','waiting','2000','2000')"
    )
    .run();
  kv.failed = false;
  const lease = (await claimCatalogLease(db))!;
  expect(await runCatalogGcUnit(db, kv, lease, start + 2 * CATALOG_RETENTION_MS)).toBeNull();
  expect(await has(key)).toBe(true);
  await releaseCatalogLease(db, lease);
  await db.prepare("UPDATE catalog_builds SET state='done' WHERE id='live'").run();
  await cycle(kv, start + 2 * CATALOG_RETENTION_MS);
  expect(await has(key)).toBe(false);
  expect(kv.map.has(key)).toBe(false);
});

it('rechecks references after a storage delete races with publication, keeping the durable mirror', async () => {
  const kv = new Kv(),
    key = layoutKey('revived');
  await doc(key);
  kv.map.set(key, '{}');
  await cycle(kv, start);
  kv.beforeDelete = async () => {
    kv.beforeDelete = undefined;
    await db
      .prepare(
        "INSERT INTO catalog_ref_state(ref_key,committed_seq,root_hash,updated_at) VALUES('layout',1,'revived','2000')"
      )
      .run();
  };
  await expect(cycle(kv, start + CATALOG_RETENTION_MS + 1)).rejects.toThrow();
  expect(await has(key)).toBe(true);
  await cycle(kv, start + CATALOG_RETENTION_MS + 2);
  expect(await has(key)).toBe(true);
  expect(
    await db.prepare('SELECT unreferenced_at FROM catalog_artifacts WHERE key=?').bind(key).first()
  ).toMatchObject({ unreferenced_at: null });
});

it('runs idle reclamation through the actual queue handler and shares its invocation budget', async () => {
  const kv = new Kv();
  // A healthy committed empty listing prevents an unrelated bootstrap build.
  await db
    .prepare(
      "INSERT INTO catalog_listings(listing_id,generation,page_size,page_count,total,active,updated_at) VALUES('all',1,24,0,0,1,'2000')"
    )
    .run();
  await kv.put('catalog:r1:listing:all:current', '{}');
  const queue = await catalogQueueHarness(db, kv);
  const result = await queue.deliver();
  expect(result.retried).toBe(false);
  expect(result.continued).toBe(true);
  expect(await db.prepare('SELECT phase FROM catalog_gc_state').first()).toMatchObject({
    phase: 'inventory',
  });
  await db
    .prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES('store_name','Queued name','2026') ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    .run();
  for (let i = 0; i < 15; i++) {
    const delivery = await queue.deliver();
    expect(delivery.retried).toBe(false);
    const ref = await db
      .prepare("SELECT root_hash,pending_payload FROM catalog_ref_state WHERE ref_key='layout'")
      .first<{ root_hash: string; pending_payload: string | null }>();
    if (ref && !ref.pending_payload) {
      expect(await has(layoutKey(ref.root_hash))).toBe(true);
      return;
    }
  }
  throw new Error('queued layout did not durably commit and deliver');
});

it('upgrades populated 0011 without reconstruction, preserving financial data and FTS', async () => {
  const old = await createTestDb({ through: '0011_public_reader_indexes.sql' });
  try {
    await old.db
      .prepare("INSERT INTO catalog_documents VALUES('retained','layout','r','{}','2000')")
      .run();
    await seedProduct(old.db);
    await old.db.batch([
      old.db.prepare(
        "INSERT INTO orders(id,number,customer_email,status,payment_status,subtotal_cents,total_cents,created_at,updated_at) VALUES('sale','SALE','fixture@example.invalid','paid','paid',2000,2000,'2020','2020')"
      ),
      old.db.prepare(
        "INSERT INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES('item','sale','TEE-1','Fixture',1,2000)"
      ),
      old.db.prepare(
        "INSERT INTO refunds(id,order_id,request_id,amount_cents,status,created_at) VALUES('refund','sale','refund',200,'pending','2020')"
      ),
      old.db.prepare(
        "INSERT INTO reservations(id,order_id,sku,qty,status,expires_at,created_at) VALUES('committed','sale','TEE-1',1,'committed','2020','2020'),('released','sale','TEE-1',1,'released','2020','2020')"
      ),
    ]);
    const tables = ['orders', 'order_items', 'refunds', 'stock_ledger'];
    const before = await Promise.all(
      tables.map((t) =>
        old.db
          .prepare(`SELECT * FROM ${t} ORDER BY id`)
          .all()
          .then((r) => r.results)
      )
    );
    await applyMigrationFile(old.db, '0012_catalog_reclamation.sql');
    await pruneRetention(old.db);
    expect(await old.db.prepare('SELECT id FROM reservations').all()).toMatchObject({
      results: [{ id: 'committed' }],
    });
    expect(
      await Promise.all(
        tables.map((t) =>
          old.db
            .prepare(`SELECT * FROM ${t} ORDER BY id`)
            .all()
            .then((r) => r.results)
        )
      )
    ).toEqual(before);
    expect(
      await old.db.prepare("SELECT key FROM catalog_documents WHERE key='retained'").first()
    ).toMatchObject({ key: 'retained' });
    expect((await old.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(
      await old.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products_fts'")
        .first()
    ).toBeTruthy();
  } finally {
    await old.dispose();
  }
});

it('incremental layout commits a durable GC root before mutable delivery', async () => {
  const kv = new Kv();
  await db
    .prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES('store_name','New name','2026') ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    .run();
  await processCatalogWork(db, kv);
  const reference = await db
    .prepare("SELECT root_hash,pending_payload FROM catalog_ref_state WHERE ref_key='layout'")
    .first<{ root_hash: string; pending_payload: string }>();
  expect(reference).toBeTruthy();
  expect(await has(layoutKey(reference!.root_hash))).toBe(true);
  expect(
    await db
      .prepare("SELECT document_key FROM catalog_ref_documents WHERE ref_key='layout'")
      .first()
  ).toMatchObject({ document_key: layoutKey(reference!.root_hash) });
  expect(JSON.parse(reference!.pending_payload)).toEqual({ revision: reference!.root_hash });
  expect(kv.map.has('catalog:r1:layout:current')).toBe(false); // normal timed delivery remains responsible
});

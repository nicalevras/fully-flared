import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { buildCatalogReadModels } from './helpers/catalog-driver';
import { readListingRef } from '../web/src/server/catalog-read';
import { ALL_LISTING } from '../web/src/server/catalog-models';
import { verifyChangedReferences } from '../web/src/server/catalog-operations';

const KV_REF_WRITE_GAP_MS = 1000;

class Kv {
  map = new Map<string, string>();
  lastWrite = new Map<string, number>();
  tooFast: string[] = [];
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    const previous = this.lastWrite.get(key);
    if (
      key.endsWith(':current') &&
      previous !== undefined &&
      Date.now() - previous < KV_REF_WRITE_GAP_MS
    )
      this.tooFast.push(key);
    this.lastWrite.set(key, Date.now());
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

let db: D1Database, dispose: () => Promise<void>, kv: Kv;

async function pendingRefs() {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM catalog_ref_state WHERE pending_payload IS NOT NULL')
    .first<{ n: number }>();
  return row?.n;
}

async function retitle(title: string) {
  await db.prepare('UPDATE products SET title=? WHERE id=?').bind(title, 'p1').run();
}

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
  kv = new Kv();
  await seedProduct(db);
});
afterEach(async () => {
  vi.useRealTimers();
  await dispose();
});

it.each([0, 500, 999, 1000, 1100, 2000])(
  'a build reports done only once its listing reference is delivered, %i ms after the previous write',
  async (gapMs) => {
    await buildCatalogReadModels(db, kv);
    const a = (await readListingRef(db, kv, ALL_LISTING))?.rootHash;
    expect(a).toEqual(expect.any(String));
    vi.setSystemTime(Date.now() + 1500);
    await retitle('B');
    await buildCatalogReadModels(db, kv);
    expect((await readListingRef(db, kv, ALL_LISTING))?.rootHash).not.toBe(a);

    vi.setSystemTime(Date.now() + gapMs);
    await retitle('Tee');
    await buildCatalogReadModels(db, kv);

    expect(await pendingRefs()).toBe(0);
    expect((await readListingRef(db, kv, ALL_LISTING))?.rootHash).toBe(a);
    expect(kv.tooFast).toEqual([]);
  }
);

const REF_KEY = (listingId: string) => `catalog:r1:listing:${listingId}:current`;

async function addCollections(count: number) {
  const ids = Array.from({ length: count }, (_, i) => `c${i + 1}`);
  await db.batch(
    ids.map((id) =>
      db
        .prepare(
          "INSERT INTO collections(id,slug,title,description,kind,created_at) VALUES(?,?,?,'','manual','2026-01-01')"
        )
        .bind(id, id, id)
    )
  );
  return ids;
}

it('a build finishes only after every reference it committed, beyond one delivery slice', async () => {
  const ids = await addCollections(6);
  await buildCatalogReadModels(db, kv);
  expect(await pendingRefs()).toBe(0);
  for (const id of ids) expect(kv.map.has(REF_KEY(id))).toBe(true);
});

it('a reference in failure backoff does not hold the build open', async () => {
  const [failing = ''] = await addCollections(2);
  const write = kv.put.bind(kv);
  kv.put = async (key, value) => {
    if (key === REF_KEY(failing)) throw new Error('KV write rejected');
    await write(key, value);
  };
  await buildCatalogReadModels(db, kv);
  const pending = await db
    .prepare(
      'SELECT ref_key, delivery_retry_at FROM catalog_ref_state WHERE pending_payload IS NOT NULL'
    )
    .all<{ ref_key: string; delivery_retry_at: string | null }>();
  expect(pending.results).toEqual([
    { ref_key: `listing:${failing}`, delivery_retry_at: expect.any(String) },
  ]);
});

function storedRef(key: string) {
  const payload: unknown = JSON.parse(kv.map.get(key) ?? 'null');
  if (typeof payload !== 'object' || payload === null || !('rootHash' in payload))
    throw new Error(`no reference payload at ${key}`);
  return payload;
}

async function dueForVerification() {
  await db
    .prepare(
      "UPDATE catalog_ref_state SET verify_after='2000-01-01T00:00:00.000Z', last_write_at='2000-01-01T00:00:00.000Z'"
    )
    .run();
}

it('verification of a stale reference logs one catalog_ref_mismatch with both hashes and repairs it', async () => {
  await buildCatalogReadModels(db, kv);
  const key = REF_KEY(ALL_LISTING);
  const expected = storedRef(key);
  kv.map.set(key, JSON.stringify({ ...expected, rootHash: 'stale-root-hash' }));
  await dueForVerification();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  await verifyChangedReferences(db, kv);

  const events = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
  expect(events).toEqual([
    expect.objectContaining({
      event: 'catalog_ref_mismatch',
      refKey: `listing:${ALL_LISTING}`,
      expectedRootHash: expected.rootHash,
      actualRootHash: 'stale-root-hash',
    }),
  ]);
  expect(storedRef(key)).toEqual(expected);
  warn.mockRestore();
});

it('verification of a matching reference logs nothing', async () => {
  await buildCatalogReadModels(db, kv);
  await dueForVerification();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  await verifyChangedReferences(db, kv);

  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});

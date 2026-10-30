import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';

let db: D1Database, dispose: () => Promise<void>;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db);
});
afterEach(async () => {
  await dispose();
});

const revision = async () =>
  (
    await db
      .prepare("SELECT value FROM settings WHERE key = 'commerce_revision'")
      .first<{ value: string }>()
  )?.value;

const updateVariant = (set: string) =>
  db.prepare(`UPDATE variants SET ${set} WHERE sku = 'TEE-1'`).run();

it('variant title edit keeps revision; price edit bumps it', async () => {
  const before = await revision();
  await updateVariant("title = 'Renamed', compare_at_cents = 9999, cost_cents = 100");
  expect(await revision()).toBe(before);
  await updateVariant('price_cents = price_cents + 1');
  expect(Number(await revision())).toBe(Number(before) + 1);
});

it('every quote-relevant variant column bumps the revision', async () => {
  const changes = ['weight_grams = 250', "status = 'draft'", 'continue_selling = 1'];
  for (const set of changes) {
    const before = Number(await revision());
    await db
      .prepare(`UPDATE variants SET ${set} WHERE id = (SELECT id FROM variants LIMIT 1)`)
      .run();
    expect(Number(await revision()), set).toBe(before + 1);
  }
});

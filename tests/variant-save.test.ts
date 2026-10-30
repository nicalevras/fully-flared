import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';

let db: D1Database, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };
const env = {} as Cloudflare.Env;

const edit = (patch: Record<string, unknown>) => ({
  variantId: 'v1',
  productId: 'p1',
  sku: 'TEE-1',
  title: 'Default',
  priceCents: 2500,
  compareAtCents: null,
  weightGrams: null,
  continueSelling: false,
  ...patch,
});

const variant = () =>
  db
    .prepare("SELECT price_cents, version FROM variants WHERE id = 'v1'")
    .first<{ price_cents: number; version: number }>();
const audited = async () =>
  (
    await db
      .prepare("SELECT action FROM audit_log WHERE action LIKE 'variant.%' ORDER BY created_at")
      .all<{ action: string }>()
  ).results.map((row) => row.action);

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db);
  await db
    .prepare(
      "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) VALUES ('p2', 'mug', 'Mug', '', 'active', '2026', '2026')"
    )
    .run();
});
afterEach(async () => {
  await dispose();
});

it('a save at the loaded version lands and bumps the version', async () => {
  const result = await runAdminAction(db, env, owner, 'variant.save', edit({ expectedVersion: 0 }));
  expect(result).toEqual({ ok: true, data: { variantId: 'v1', version: 1 } });
  expect(await variant()).toEqual({ price_cents: 2500, version: 1 });
  expect(await audited()).toEqual(['variant.save']);
});

it('stale version is a conflict', async () => {
  await runAdminAction(db, env, owner, 'variant.save', edit({ expectedVersion: 0 }));
  const result = await runAdminAction(
    db,
    env,
    owner,
    'variant.save',
    edit({ priceCents: 9900, expectedVersion: 0 })
  );
  expect(result).toMatchObject({ ok: false, conflict: true, status: 409 });
  expect(await variant()).toEqual({ price_cents: 2500, version: 1 });
  expect(await audited()).toEqual(['variant.save']);
});

it('an edit without the loaded version is refused', async () => {
  const result = await runAdminAction(db, env, owner, 'variant.save', edit({}));
  expect(result).toMatchObject({ ok: false, status: 400 });
  expect(await variant()).toEqual({ price_cents: 2000, version: 0 });
});

it('wrong product is not found', async () => {
  const result = await runAdminAction(
    db,
    env,
    owner,
    'variant.save',
    edit({ productId: 'p2', expectedVersion: 0 })
  );
  expect(result).toMatchObject({ ok: false, status: 404 });
  expect(result).not.toHaveProperty('conflict');
  expect(await variant()).toEqual({ price_cents: 2000, version: 0 });
  expect(await audited()).toEqual([]);
});

it('bulk edit bumps version', async () => {
  const result = await runAdminAction(db, env, owner, 'variant.bulkUpdate', {
    variantIds: ['v1'],
    priceCents: 1500,
  });
  expect(result).toMatchObject({ ok: true });
  expect(await variant()).toEqual({ price_cents: 1500, version: 1 });

  const stale = await runAdminAction(db, env, owner, 'variant.save', edit({ expectedVersion: 0 }));
  expect(stale).toMatchObject({ ok: false, conflict: true, status: 409 });
  expect(await variant()).toEqual({ price_cents: 1500, version: 1 });
});

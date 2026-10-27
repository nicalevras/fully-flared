import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';

let db: D1Database, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };
const env = {} as Cloudflare.Env;

async function media(id: string) {
  await db
    .prepare(
      "INSERT INTO media(id,r2_key,filename,content_type,alt_text,ready,created_at) VALUES(?,?,?, 'image/png', '', 1, '2026')"
    )
    .bind(id, `${id}.png`, `${id}.png`)
    .run();
}

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db);
  await media('m1');
  await media('m2');
  await media('m3');
  for (const id of ['m1', 'm2', 'm3']) {
    const result = await runAdminAction(db, env, owner, 'product.attachMedia', {
      productId: 'p1',
      mediaId: id,
    });
    expect(result.ok).toBe(true);
  }
});
afterEach(async () => {
  await dispose();
});

async function order(): Promise<string[]> {
  const rows = await db
    .prepare('SELECT media_id FROM product_media WHERE product_id = ? ORDER BY position')
    .bind('p1')
    .all<{ media_id: string }>();
  return rows.results.map((row) => row.media_id);
}

describe('Phase 5A product media', () => {
  it('attaches existing library media in attach order', async () => {
    expect(await order()).toEqual(['m1', 'm2', 'm3']);
  });

  it('rejects attaching the same media twice', async () => {
    const result = await runAdminAction(db, env, owner, 'product.attachMedia', {
      productId: 'p1',
      mediaId: 'm1',
    });
    expect(result.ok).toBe(false);
    expect(await order()).toEqual(['m1', 'm2', 'm3']);
  });

  it('reorders media so the first row becomes the cover', async () => {
    const result = await runAdminAction(db, env, owner, 'product.reorderMedia', {
      productId: 'p1',
      mediaIds: ['m3', 'm1', 'm2'],
    });
    expect(result.ok).toBe(true);
    expect(await order()).toEqual(['m3', 'm1', 'm2']);
  });

  it('rejects a stale order that no longer matches the attached set', async () => {
    const result = await runAdminAction(db, env, owner, 'product.reorderMedia', {
      productId: 'p1',
      mediaIds: ['m3', 'm1'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toBe(true);
    expect(await order()).toEqual(['m1', 'm2', 'm3']);
  });
});

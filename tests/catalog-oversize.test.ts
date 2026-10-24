import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';
import { adminActionSchema } from '../web/src/schemas/admin';
import { failingCatalogWork } from '../web/src/server/catalog-operations';
import { catalogWork } from './helpers/catalog-driver';

class Kv {
  map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

let db: D1Database;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => {
  vi.useRealTimers();
  await dispose();
});

const post = (contentHtml: string) => ({
  action: 'post.save',
  slug: 'big',
  title: 'Big',
  contentHtml,
  status: 'published',
});

it('rejects editorial HTML at save time when its encoded size cannot be published', () => {
  const rejected = adminActionSchema.safeParse(post('中'.repeat(500_000)));
  expect(rejected.success).toBe(false);
  expect(rejected.error?.issues[0]?.message).toMatch(/too large to publish/);
  expect(adminActionSchema.safeParse(post('中'.repeat(400_000))).success).toBe(true);
});

it('records why oversized work fails and backs off exponentially', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = new Date('2026-10-23T12:00:00.000Z');
  vi.setSystemTime(start);
  const kv = new Kv();
  await db.prepare('UPDATE catalog_work SET processed_revision=target_revision').run();
  await db
    .prepare(
      "INSERT INTO posts(id,slug,title,excerpt,content_html,status,published_at,created_at,updated_at) VALUES('big','big','Big','',?,'published','2026-01-01','2026-01-01','2026-01-01')"
    )
    .bind('中'.repeat(600_000))
    .run();
  const attempt = async () => {
    await expect(catalogWork(db, kv)).rejects.toThrow(/byte budget/);
    return db
      .prepare(
        "SELECT last_error,retry_count,next_attempt_at FROM catalog_work WHERE id='post:big'"
      )
      .first<{ last_error: string; retry_count: number; next_attempt_at: string }>();
  };
  const first = await attempt();
  expect(first).toMatchObject({ retry_count: 1, last_error: expect.stringMatching(/byte budget/) });
  expect(Date.parse(first?.next_attempt_at ?? '') - start.getTime()).toBe(60_000);
  vi.setSystemTime(new Date(first?.next_attempt_at ?? ''));
  const second = await attempt();
  expect(Date.parse(second?.next_attempt_at ?? '') - Date.parse(first?.next_attempt_at ?? '')).toBe(
    120_000
  );
  await db.prepare("UPDATE catalog_work SET retry_count=20 WHERE id='post:big'").run();
  vi.setSystemTime(new Date(second?.next_attempt_at ?? ''));
  const capped = await attempt();
  expect(
    Date.parse(capped?.next_attempt_at ?? '') - Date.parse(second?.next_attempt_at ?? '')
  ).toBe(3_600_000);
  const failures = await failingCatalogWork(db);
  expect(failures.count).toBe(1);
  expect(failures.items[0]).toMatchObject({
    entity_type: 'post',
    entity_id: 'big',
    last_error: expect.stringMatching(/byte budget/),
  });
});

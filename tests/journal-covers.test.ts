import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { buildCatalogReadModels } from './helpers/catalog-driver';
import { listPublishedPosts } from '../web/src/server/catalog-read';
import { postSummarySchema } from '../web/src/server/catalog-models';

let db: D1Database;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => dispose());

it('publishes journal covers with each card without per-post database reads', async () => {
  await db.batch([
    db.prepare(
      "INSERT INTO media(id,r2_key,filename,content_type,public_url,ready,deletion_pending,created_at) VALUES('cover','journal/cover.jpg','cover.jpg','image/jpeg','https://images.example.com/cover.jpg',1,0,'2026-01-01')"
    ),
    ...['covered', 'plain', 'draft'].map((id) =>
      db
        .prepare(
          "INSERT INTO posts(id,slug,title,excerpt,content_html,status,cover_media_id,published_at,created_at,updated_at) VALUES(?,?,?,'News','<p>News</p>',?,?,'2026-01-01','2026-01-01','2026-01-01')"
        )
        .bind(id, id, id, id === 'draft' ? 'draft' : 'published', id === 'covered' ? 'cover' : null)
    ),
  ]);
  const values = new Map<string, string>();
  const kv = {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
  await buildCatalogReadModels(db, kv);
  const forbidden = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return () => {
          throw new Error('Unexpected journal D1 read');
        };
      return Reflect.get(target, key);
    },
  });
  const listing = await listPublishedPosts(forbidden, { CATALOG_KV: kv });
  expect(listing.total).toBe(2);
  expect(listing.posts.find((post) => post.slug === 'covered')).toMatchObject({
    cover_key: 'journal/cover.jpg',
    cover_public_url: 'https://images.example.com/cover.jpg',
  });
  expect(listing.posts.find((post) => post.slug === 'plain')).toMatchObject({
    cover_key: null,
    cover_public_url: null,
  });

  await db.prepare("UPDATE media SET ready=0 WHERE id='cover'").run();
  await buildCatalogReadModels(db, kv);
  expect(
    (await listPublishedPosts(forbidden, { CATALOG_KV: kv })).posts.find(
      (post) => post.slug === 'covered'
    )
  ).toMatchObject({ cover_key: null, cover_public_url: null });
});

it('accepts existing published summaries without cover fields', () => {
  expect(
    postSummarySchema.safeParse({
      id: 'old',
      slug: 'old',
      title: 'Old',
      excerpt: '',
      published_at: '2026-01-01',
    }).success
  ).toBe(true);
});

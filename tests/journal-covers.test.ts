import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyMigrationFile, createTestDb } from './helpers/d1';
import { buildCatalogReadModels } from './helpers/catalog-driver';
import { listPublishedPosts } from '../web/src/server/catalog-read';
import { postSummarySchema } from '../web/src/server/catalog-models';
import { mediaSrcSet, mediaUrl } from '../web/src/lib/media-url';

let db: D1Database;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => dispose());

it('refreshes an existing journal index without creating one before catalog bootstrap', async () => {
  expect(
    await db.prepare("SELECT id FROM catalog_builds WHERE id='index:@posts'").first()
  ).toBeNull();
  await buildCatalogReadModels(db);
  await applyMigrationFile(db, '0018_journal_cover_index.sql');
  await applyMigrationFile(db, '0018_journal_cover_index.sql');
  expect(
    await db
      .prepare("SELECT state,scope_listing_id FROM catalog_builds WHERE id='index:@posts'")
      .first()
  ).toEqual({ state: 'building', scope_listing_id: '@posts' });
});

it('publishes ready journal variants and reads cached cards without database access', async () => {
  await db.batch([
    ...[
      ['cover', 'journal/cover image.jpg', 'https://images.example.com/cover.jpg', 1, 0],
      ['original', 'journal/original.jpg', 'https://images.example.com/original.jpg', 1, 0],
      ['local', 'journal/local image.jpg', null, 1, 0],
      ['unready', 'journal/unready.jpg', null, 1, 0],
    ].map((values) =>
      db
        .prepare(
          "INSERT INTO media(id,r2_key,public_url,ready,deletion_pending,filename,content_type,created_at) VALUES(?,?,?,?,?,'cover.jpg','image/jpeg','2026-01-01')"
        )
        .bind(...values)
    ),
    ...[
      ['cover', 320, 'https://images.example.com/cover-320.jpg', 1],
      ['cover', 640, null, 1],
      ['cover', 960, 'https://images.example.com/cover-960.jpg', 0],
      ['cover', 1600, 'https://images.example.com/cover-1600.jpg', 1],
      ['unready', 640, null, 1],
    ].map(([id, width, url, ready]) =>
      db
        .prepare(
          "INSERT INTO media_variants(media_id,width,public_url,ready,r2_key,content_type,bytes,sha256,created_at) VALUES(?,?,?,?,?,'image/jpeg',100,'digest','2026-01-01')"
        )
        .bind(id, width, url, ready, `variants/${id}-${width}.jpg`)
    ),
    ...['cover', 'original', 'local', 'unready', 'plain', 'draft'].map((id) =>
      db
        .prepare(
          "INSERT INTO posts(id,slug,title,excerpt,content_html,status,cover_media_id,published_at,created_at,updated_at) VALUES(?,?,?,'News','<p>News</p>',?,?,'2026-01-01','2026-01-01','2026-01-01')"
        )
        .bind(
          id,
          id,
          id,
          id === 'draft' ? 'draft' : 'published',
          ['plain', 'draft'].includes(id) ? null : id
        )
    ),
    db.prepare("UPDATE media SET ready=0 WHERE id='unready'"),
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
  expect(listing.total).toBe(5);
  const covered = listing.posts.find((post) => post.slug === 'cover');
  expect(covered).toMatchObject({
    cover_key: 'journal/cover image.jpg',
    cover_public_url: 'https://images.example.com/cover.jpg',
    cover_variants: [
      { width: 320, url: 'https://images.example.com/cover-320.jpg' },
      { width: 640, url: '/media/journal%2Fcover%20image.jpg?w=640' },
      { width: 1600, url: 'https://images.example.com/cover-1600.jpg' },
    ],
  });
  if (!covered?.cover_key) throw new Error('Expected a published cover');
  const source = {
    key: covered.cover_key,
    publicUrl: covered.cover_public_url,
    variants: covered.cover_variants,
  };
  expect(mediaUrl(source, 640)).toBe('/media/journal%2Fcover%20image.jpg?w=640');
  expect(mediaSrcSet(source)).toBe(
    'https://images.example.com/cover-320.jpg 320w,/media/journal%2Fcover%20image.jpg?w=640 640w,https://images.example.com/cover-1600.jpg 1600w'
  );
  for (const slug of ['plain', 'unready']) {
    expect(listing.posts.find((post) => post.slug === slug)).toMatchObject({
      cover_key: null,
      cover_public_url: null,
      cover_variants: [],
    });
  }
  for (const slug of ['original', 'local']) {
    const post = listing.posts.find((post) => post.slug === slug);
    if (!post?.cover_key) throw new Error(`Expected ${slug} cover`);
    expect(post.cover_variants).toEqual([]);
    const originalSource = {
      key: post.cover_key,
      publicUrl: post.cover_public_url,
      variants: post.cover_variants,
    };
    expect(mediaUrl(originalSource, 640)).toBe(
      slug === 'original'
        ? 'https://images.example.com/original.jpg'
        : '/media/journal%2Flocal%20image.jpg'
    );
    expect(mediaSrcSet(originalSource)).toBeUndefined();
  }
});

it('requires the current cover contract in every published summary', () => {
  const post = {
    id: 'post',
    slug: 'post',
    title: 'Post',
    excerpt: '',
    published_at: '2026-01-01',
  };
  expect(postSummarySchema.safeParse(post).success).toBe(false);
  expect(
    postSummarySchema.safeParse({ ...post, cover_key: null, cover_public_url: null }).success
  ).toBe(false);
  expect(
    postSummarySchema.safeParse({ ...post, cover_key: null, cover_variants: [] }).success
  ).toBe(false);
  expect(
    postSummarySchema.safeParse({ ...post, cover_public_url: null, cover_variants: [] }).success
  ).toBe(false);
  expect(
    postSummarySchema.safeParse({
      ...post,
      cover_key: null,
      cover_public_url: null,
      cover_variants: [],
    }).success
  ).toBe(true);
});

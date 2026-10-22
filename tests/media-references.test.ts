import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDb } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';
import { canonicalizeMediaUrls, mediaKeysInContent } from '../web/src/server/media';

let db: D1Database, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };
const removed: string[] = [];
const env = {
  MEDIA: {
    delete: vi.fn(async (key: string) => {
      removed.push(key);
    }),
  },
} as never;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  removed.length = 0;
  vi.clearAllMocks();
  await db
    .prepare(
      "INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES('owner','Owner','owner@example.invalid','owner',0,0)"
    )
    .run();
});
afterEach(async () => {
  await dispose();
});

async function media(id: string, key: string) {
  await db
    .prepare(
      "INSERT INTO media(id,r2_key,filename,content_type,created_at) VALUES(?,?,?,'image/jpeg','2026')"
    )
    .bind(id, key, key)
    .run();
}

async function post(id: string, html: string, json = '', cover: string | null = null) {
  await db
    .prepare(
      "INSERT INTO posts(id,slug,title,content_html,content_json,status,cover_media_id,created_at,updated_at) VALUES(?,?,?,?,?,'published',?,'2026','2026')"
    )
    .bind(id, id, id, html, json || null, cover)
    .run();
}

async function usedCount(mediaId: string): Promise<number> {
  // Mirrors the media list loader: SQL structural counts plus a shared-
  // extractor scan of editorial content (one per content row).
  const row = await db
    .prepare(
      `SELECT m.r2_key,
       (SELECT COUNT(*) FROM product_media pm WHERE pm.media_id = m.id)
       + (SELECT COUNT(*) FROM posts p WHERE p.cover_media_id = m.id) AS structural
       FROM media m WHERE m.id = ?`
    )
    .bind(mediaId)
    .first<{ r2_key: string; structural: number }>();
  if (!row) return -1;
  let content = 0;
  const posts = await db.prepare('SELECT content_html, content_json FROM posts').all<{
    content_html: string | null;
    content_json: string | null;
  }>();
  for (const p of posts.results)
    if (
      new Set([...mediaKeysInContent(p.content_html), ...mediaKeysInContent(p.content_json)]).has(
        row.r2_key
      )
    )
      content++;
  const pages = await db.prepare('SELECT content_html FROM pages').all<{
    content_html: string | null;
  }>();
  for (const p of pages.results)
    if (mediaKeysInContent(p.content_html).includes(row.r2_key)) content++;
  return row.structural + content;
}

function savePage(id: string, contentHtml: string) {
  return runAdminAction(
    db,
    env,
    owner,
    'page.save',
    { id, slug: id, title: id, contentHtml },
    undefined,
    'https://shop.invalid'
  );
}

function savePost(id: string, contentHtml: string, extra: Record<string, unknown> = {}) {
  return runAdminAction(
    db,
    env,
    owner,
    'post.save',
    { id, slug: id, title: id, contentHtml, status: 'published', ...extra },
    undefined,
    'https://shop.invalid'
  );
}

describe('mediaKeysInContent', () => {
  it('recognizes relative, responsive, and accepted-origin absolute URLs', () => {
    expect(mediaKeysInContent('<img src="/media/a.jpg">')).toEqual(['a.jpg']);
    expect(mediaKeysInContent('<img src="/media/a.jpg?w=320">')).toEqual(['a.jpg']);
    expect(
      mediaKeysInContent('<img src="https://shop.invalid/media/b.jpg?w=640">', [
        'https://shop.invalid',
      ])
    ).toEqual(['b.jpg']);
    expect(mediaKeysInContent('{"src":"\\/media\\/c.jpg"}')).toEqual(['c.jpg']);
  });

  it('decodes percent-encoded keys exactly once', () => {
    expect(mediaKeysInContent('<img src="/media/%61bc.jpg">')).toEqual(['abc.jpg']);
    expect(mediaKeysInContent('<img src="/media/%61bc.jpg?w=320">')).toEqual(['abc.jpg']);
    // Double-encoded decodes once to a still-encoded key, which is not a
    // servable media key (matching the route's single decode).
    expect(mediaKeysInContent('<img src="/media/%2561bc.jpg">')).toEqual([]);
    expect(canonicalizeMediaUrls('<img src="/media/%61bc.jpg?w=320">')).toBe(
      '<img src="/media/abc.jpg?w=320">'
    );
  });

  it('ignores foreign-host URLs, even under /media/', () => {
    expect(
      mediaKeysInContent('<img src="https://another-site.example/media/banner.jpg">', [
        'https://shop.invalid',
      ])
    ).toEqual([]);
  });
});

describe('inline media references', () => {
  it('post HTML reference counts as usage and blocks deletion', async () => {
    await media('m', 'img1.jpg');
    await post('p1', '<p><img src="/media/img1.jpg"></p>');
    expect(await usedCount('m')).toBe(1);
    const result = await runAdminAction(db, env, owner, 'media.delete', { mediaId: 'm' });
    expect(result.ok).toBe(false);
    expect(removed).toEqual([]);
    expect(await db.prepare("SELECT id FROM media WHERE id='m'").first()).not.toBeNull();
  });

  it('page HTML reference blocks deletion', async () => {
    await media('m', 'img2.jpg');
    await db
      .prepare(
        "INSERT INTO pages(id,slug,title,content_html,created_at,updated_at) VALUES('pg','pg','Pg','<img src=\"/media/img2.jpg\">','2026','2026')"
      )
      .run();
    expect(await usedCount('m')).toBe(1);
    expect((await runAdminAction(db, env, owner, 'media.delete', { mediaId: 'm' })).ok).toBe(false);
  });

  it('post JSON reference counts as usage', async () => {
    await media('m', 'img3.jpg');
    await post(
      'p1',
      '<p>text</p>',
      '{"type":"doc","content":[{"attrs":{"src":"/media/img3.jpg"}}]}'
    );
    expect(await usedCount('m')).toBe(1);
  });

  it('foreign URL embedding a known local key conservatively blocks deletion', async () => {
    await media('m', 'img4.jpg');
    await post('p1', '<img src="https://mirror.example/media/img4.jpg">');
    // Documented over-protection: SQL substring checks are host-agnostic.
    expect((await runAdminAction(db, env, owner, 'media.delete', { mediaId: 'm' })).ok).toBe(false);
  });

  it('race A: a saved inline reference blocks the deletion claim', async () => {
    await media('m', 'race-a.jpg');
    expect((await savePost('post-a', '<img src="/media/race-a.jpg">')).ok).toBe(true);
    expect((await runAdminAction(db, env, owner, 'media.delete', { mediaId: 'm' })).ok).toBe(false);
    expect(await db.prepare("SELECT id FROM media WHERE id='m'").first()).not.toBeNull();
  });

  it('race B: a save introducing a pending image is rejected, inline and as cover', async () => {
    await media('m', 'race-b.jpg');
    const failingEnv = {
      MEDIA: {
        delete: vi
          .fn()
          .mockRejectedValueOnce(new Error('storage unavailable'))
          .mockResolvedValue(undefined),
      },
    } as never;
    await runAdminAction(db, failingEnv, owner, 'media.delete', { mediaId: 'm' });
    expect(
      (await db.prepare("SELECT deletion_pending FROM media WHERE id='m'").first())
        ?.deletion_pending
    ).toBe(1);
    const inline = await savePost('post-b', '<img src="/media/race-b.jpg">');
    expect(inline).toMatchObject({ ok: false, status: 409 });
    expect(await db.prepare("SELECT id FROM posts WHERE id='post-b'").first()).toBeNull();
    const cover = await savePost('post-c', '<p>x</p>', { coverMediaId: 'm' });
    expect(cover).toMatchObject({ ok: false, status: 409 });
  });

  it('stale save cannot restore a reference removed before the media was deleted', async () => {
    await media('m', 'stale.jpg');
    expect((await savePost('post-s', '<img src="/media/stale.jpg">')).ok).toBe(true);
    expect((await savePost('post-s', '<p>no image</p>')).ok).toBe(true);
    expect((await runAdminAction(db, env, owner, 'media.delete', { mediaId: 'm' })).ok).toBe(true);
    const stale = await savePost('post-s', '<img src="/media/stale.jpg">');
    expect(stale).toMatchObject({ ok: false, status: 409 });
    const stored = await db
      .prepare("SELECT content_html FROM posts WHERE id='post-s'")
      .first<{ content_html: string }>();
    expect(stored?.content_html).not.toContain('stale.jpg');
  });

  it('save after the media row was deleted rejects the new broken reference', async () => {
    await media('m', 'gone.jpg');
    expect((await runAdminAction(db, env, owner, 'media.delete', { mediaId: 'm' })).ok).toBe(true);
    const result = await savePost('post-g', '<img src="/media/gone.jpg">');
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(await db.prepare("SELECT id FROM posts WHERE id='post-g'").first()).toBeNull();
  });

  it('absolute local URL with canonical unset is guarded via the request origin', async () => {
    await media('m', 'abs.jpg');
    const failingEnv = {
      MEDIA: {
        delete: vi
          .fn()
          .mockRejectedValueOnce(new Error('storage unavailable'))
          .mockResolvedValue(undefined),
      },
    } as never;
    await runAdminAction(db, failingEnv, owner, 'media.delete', { mediaId: 'm' });
    const result = await savePost('post-abs', '<img src="https://shop.invalid/media/abs.jpg">');
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it('already-stored broken references are grandfathered in HTML and JSON; new ones are not', async () => {
    await post('p-old', '<img src="/media/old-gone.jpg">', '{"src":"/media/old-json.jpg"}');
    const resaved = await savePost('p-old', '<img src="/media/old-gone.jpg">', {
      contentJson: '{"src":"/media/old-json.jpg"}',
    });
    expect(resaved.ok).toBe(true);
    const withNew = await savePost(
      'p-old',
      '<img src="/media/old-gone.jpg"><img src="/media/new-gone.jpg">',
      {
        contentJson: '{"src":"/media/old-json.jpg"}',
      }
    );
    expect(withNew).toMatchObject({ ok: false, status: 409 });
  });

  it('escaped JSON reference counts as usage and blocks deletion', async () => {
    await media('m', 'esc.jpg');
    await post('p1', '<p>text</p>', '{"src":"\\/media\\/esc.jpg"}');
    expect(await usedCount('m')).toBe(1);
    expect((await runAdminAction(db, env, owner, 'media.delete', { mediaId: 'm' })).ok).toBe(false);
    expect(removed).toEqual([]);
    expect(await db.prepare("SELECT id FROM media WHERE id='m'").first()).not.toBeNull();
  });

  it('escaped JSON reference to missing media is grandfathered on resave', async () => {
    await post('p-esc', '<p>text</p>', '{"src":"\\/media\\/esc-gone.jpg"}');
    const resaved = await savePost('p-esc', '<p>text</p>', {
      contentJson: '{"src":"\\/media\\/esc-gone.jpg"}',
    });
    expect(resaved.ok).toBe(true);
  });

  it('legacy percent-encoded page reference counts and blocks deletion', async () => {
    await media('m', 'abc.jpg');
    await db
      .prepare(
        "INSERT INTO pages(id,slug,title,content_html,created_at,updated_at) VALUES('pg-enc','pg-enc','Pg','<img src=\"/media/%61bc.jpg\">','2026','2026')"
      )
      .run();
    expect(await usedCount('m')).toBe(1);
    expect((await runAdminAction(db, env, owner, 'media.delete', { mediaId: 'm' })).ok).toBe(false);
    expect(removed).toEqual([]);
  });

  it('save introducing an encoded reference to pending media is rejected', async () => {
    await media('m', 'enc.jpg');
    const failingEnv = {
      MEDIA: {
        delete: vi
          .fn()
          .mockRejectedValueOnce(new Error('storage unavailable'))
          .mockResolvedValue(undefined),
      },
    } as never;
    await runAdminAction(db, failingEnv, owner, 'media.delete', { mediaId: 'm' });
    const result = await savePost('post-enc', '<img src="/media/%65nc.jpg">');
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(await db.prepare("SELECT id FROM posts WHERE id='post-enc'").first()).toBeNull();
  });

  it('encoded references are stored canonicalized', async () => {
    await media('m', 'abc.jpg');
    expect((await savePost('post-canon', '<img src="/media/%61bc.jpg?w=320">')).ok).toBe(true);
    const stored = await db
      .prepare("SELECT content_html FROM posts WHERE id='post-canon'")
      .first<{ content_html: string }>();
    expect(stored?.content_html).toContain('/media/abc.jpg?w=320');
    expect(stored?.content_html).not.toContain('%61');
  });

  it('legacy encoded reference to missing media is grandfathered on resave', async () => {
    await post('p-enc-old', '<img src="/media/%61bc-gone.jpg">');
    expect((await savePost('p-enc-old', '<img src="/media/%61bc-gone.jpg">')).ok).toBe(true);
  });

  it('15 legacy encoded references resave within the parameter budget', async () => {
    const html = Array.from(
      { length: 15 },
      (_, i) => `<img src="/media/%70ost-gone-${i}.jpg">`
    ).join('');
    await post('p15', html);
    expect((await savePost('p15', html)).ok).toBe(true);
    const stored = await db
      .prepare("SELECT content_html FROM posts WHERE id='p15'")
      .first<{ content_html: string }>();
    expect(stored?.content_html).toContain('/media/post-gone-0.jpg');
  });

  it('a page over the old parameter budget resaves successfully', async () => {
    const html = Array.from(
      { length: 25 },
      (_, i) => `<img src="/media/%70age-gone-${i}.jpg">`
    ).join('');
    await db
      .prepare(
        "INSERT INTO pages(id,slug,title,content_html,created_at,updated_at) VALUES('pg25','pg25','Pg',?,'2026','2026')"
      )
      .bind(html)
      .run();
    expect((await savePage('pg25', html)).ok).toBe(true);
  });

  it('one key with many distinct encoded spellings stays within budget and still rejects new missing keys', async () => {
    const base = 'spellbound-image.jpg';
    const enc = (c: string) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    const spellings = Array.from({ length: 30 }, (_, n) => {
      const chars = base.split('');
      const p1 = n % chars.length;
      chars[p1] = enc(base[p1] ?? '');
      if (n >= chars.length) {
        const p2 = (n * 3 + 1) % chars.length;
        if (p2 !== p1) chars[p2] = enc(base[p2] ?? '');
      }
      return chars.join('');
    });
    expect(new Set(spellings).size).toBeGreaterThanOrEqual(25);
    const html = spellings.map((s) => `<img src="/media/${s}">`).join('');
    await post('p-spell', html);
    expect((await savePost('p-spell', html)).ok).toBe(true);
    const withNew = await savePost('p-spell', html + '<img src="/media/never-stored.jpg">');
    expect(withNew).toMatchObject({ ok: false, status: 409 });
  });

  it('stale save cannot restore a multi-spelling reference removed before deletion', async () => {
    await media('m', 'multi.jpg');
    const html =
      '<img src="/media/%6dulti.jpg"><img src="/media/m%75lti.jpg"><img src="/media/multi.jpg">';
    await post('p-multi', html);
    expect((await savePost('p-multi', '<p>no image</p>')).ok).toBe(true);
    expect((await runAdminAction(db, env, owner, 'media.delete', { mediaId: 'm' })).ok).toBe(true);
    const stale = await savePost('p-multi', html);
    expect(stale).toMatchObject({ ok: false, status: 409 });
    const stored = await db
      .prepare("SELECT content_html FROM posts WHERE id='p-multi'")
      .first<{ content_html: string }>();
    expect(stored?.content_html).not.toContain('multi.jpg');
  });

  it('a brand-new document referencing missing media is rejected', async () => {
    const result = await savePost('post-brand-new', '<img src="/media/definitely-missing.jpg">');
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(await db.prepare("SELECT id FROM posts WHERE id='post-brand-new'").first()).toBeNull();
  });

  it('a save with over 100 valid references succeeds (chunked guards)', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 120; i++) {
      await media(`m${i}`, `bulk-${i}.jpg`);
      keys.push(`bulk-${i}.jpg`);
    }
    const html = keys.map((key) => `<img src="/media/${key}">`).join('');
    expect((await savePost('post-bulk', html)).ok).toBe(true);
  });
});

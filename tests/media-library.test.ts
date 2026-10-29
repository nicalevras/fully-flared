import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('media library table and sheet', () => {
  it('renders files in a shadcn table and edits alt text in a sheet', () => {
    const page = readFileSync('web/src/routes/admin/media.tsx', 'utf8');
    expect(page).toContain("from '../../components/ui/data-table'");
    expect(page).toContain('<DataTable');
    expect(page).not.toContain('cardCls');
    expect(page).not.toContain('sm:grid-cols-2');
    expect(page).not.toContain('Save alt text');
    expect(page).toContain('mediaUrl(mediaSource(m), 320)');
    expect(page).not.toContain('src={`/media/${m.r2_key}`}');
    expect(page).toContain('edit: m.id');
    expect(page).toContain('MediaSheet');
    expect(page).toContain("'media.updateAlt'");
    expect(page).toContain("'media.delete'");
    expect(page).toContain('LIMIT ? OFFSET ?');
    expect(page).not.toContain('LIMIT 200');
    expect(page).toContain('<DataTable');
    expect(page).not.toContain('mediaKeysInContent');
    expect(page).toContain("header: 'Type'");
    expect(page).not.toContain("header: 'Used'");
    expect(page).toContain("m.alt_text || 'No alt text'");
    const listLoader = page.slice(
      page.indexOf('const getData'),
      page.indexOf('export const getMediaDetail')
    );
    expect(listLoader).not.toContain('used_count');
    expect(listLoader).not.toContain('WITH keys');
    expect(listLoader).not.toContain('getSettings');
    expect(listLoader).not.toContain('SELECT content_html');
    const detail = page.slice(page.indexOf('export const getMediaDetail'));
    expect(detail).toContain("'/media/' || k");
    expect(detail).toContain('settings.logoMediaId === data.mediaId');
    expect(detail).toContain('settings.heroMediaId === data.mediaId');
  });
});

describe('media content counts in SQL', () => {
  it('counts each referencing content row once for the page keys', async () => {
    const { createTestDb } = await import('./helpers/d1');
    const { db, dispose } = await createTestDb();
    try {
      await db
        .prepare(
          "INSERT INTO posts(id,slug,title,content_html,content_json,status,created_at,updated_at) VALUES('p1','p1','p1','<img src=\"/media/a.jpg\">','{\"src\":\"\\/media\\/a.jpg\"}','published','2026','2026')"
        )
        .run();
      await db
        .prepare(
          "INSERT INTO pages(id,slug,title,content_html,created_at,updated_at) VALUES('pg1','pg1','pg1','<img src=\"https://shop.example/media/a.jpg\">','2026','2026')"
        )
        .run();
      const keys = ['a.jpg', 'b.jpg'];
      const values = keys.map(() => '(?)').join(',');
      const counts = await db
        .prepare(
          `WITH keys(k) AS (VALUES ${values})
           SELECT k,
             (SELECT COUNT(*) FROM posts
               WHERE instr(REPLACE(content_html, '\\/', '/'), '/media/' || k) > 0
                  OR instr(REPLACE(COALESCE(content_json, ''), '\\/', '/'), '/media/' || k) > 0)
             + (SELECT COUNT(*) FROM pages
               WHERE instr(REPLACE(content_html, '\\/', '/'), '/media/' || k) > 0) AS n
           FROM keys`
        )
        .bind(...keys)
        .all<{ k: string; n: number }>();
      expect(Object.fromEntries(counts.results.map((r) => [r.k, r.n]))).toEqual({
        'a.jpg': 2,
        'b.jpg': 0,
      });
    } finally {
      await dispose();
    }
  });
});

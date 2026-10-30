import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';
import { escapeHtml, sanitizeHtml } from '../web/src/server/sanitize';

const attacks: [string, string][] = [
  ['<img/src=x/onerror=alert(1)>', ' onerror='],
  ['<a href=javascript:alert(1)>click</a>', 'javascript:'],
  ['<a href="&#x6a;avascript:alert(1)">click</a>', 'javascript:'],
  ['<p><script>alert(1)</script>ok</p>', '<script'],
  ['<div><style>*{background:url(javascript:alert(1))}</style>ok</div>', '<style'],
  ['<svg><script>alert(1)</script></svg>', '<svg'],
  ['<math><mi//xlink:href="data:x,<script>alert(4)</script>">', 'xlink:href'],
  ['<iframe src="https://evil.example"></iframe>', '<iframe'],
  ['<p onclick="alert(1)">ok</p>', 'onclick'],
  ['<img src="x" srcset="javascript:alert(1)">', 'javascript:'],
  [
    '<svg><animate attributeName="href" values="https://safe.example;javascript:alert(1)" /></svg>',
    '<animate',
  ],
  ['<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', '<meta'],
  ['<noscript><p></noscript><img src=x onerror=alert(1)>', 'onerror'],
];

describe('allowlist HTML sanitizer', () => {
  it.each(attacks)('removes attack payload: %s', (payload, forbidden) => {
    const clean = sanitizeHtml(payload);
    expect(clean.toLowerCase()).not.toContain(forbidden.toLowerCase());
    expect(clean).not.toMatch(/<script|<iframe|<svg|\son\w+\s*=|(?:href|src)\s*=\s*"?javascript:/i);
  });

  it('keeps ordinary editorial markup and safe links/images', () => {
    const clean = sanitizeHtml(
      '<h2>Title</h2><p>Text with <strong>bold</strong> and <a href="https://example.com" target="_blank">a link</a>.</p><img src="/media/a.jpg" alt="A">'
    );
    expect(clean).toContain('<h2>Title</h2>');
    expect(clean).toContain('<strong>bold</strong>');
    expect(clean).toContain('href="https://example.com"');
    expect(clean).toContain('<img src="/media/a.jpg" alt="A" />');
  });

  it('escapes user values for email templates', () => {
    expect(escapeHtml('<b>"x"</b> & \'y\'')).toBe(
      '&lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; &#39;y&#39;'
    );
  });
});

describe('editorial content is sanitized when saved', () => {
  let db: D1Database, env: Env, dispose: () => Promise<void>;
  const owner = { id: 'owner', role: 'owner' };
  beforeEach(async () => {
    ({ db, env, dispose } = await createTestDb());
    await db
      .prepare(
        "INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES('owner','Owner','owner@example.invalid','owner',0,0)"
      )
      .run();
  });
  afterEach(async () => {
    await dispose();
  });

  it.each([
    ['page.save', 'pages', {}],
    ['post.save', 'posts', { status: 'published' }],
  ])('%s stores no attack payload for storefront reads to render', async (action, table, extra) => {
    const contentHtml = attacks.map(([payload]) => payload).join('') + '<p>kept</p>';
    const saved = await runAdminAction(
      db,
      env,
      owner,
      action,
      { id: 'x', slug: 'x', title: 'x', contentHtml, ...extra },
      undefined,
      'https://shop.invalid'
    );
    expect(saved.ok).toBe(true);
    const row = await db
      .prepare(`SELECT content_html FROM ${table} WHERE id='x'`)
      .first<{ content_html: string }>();
    expect(row?.content_html).toContain('<p>kept</p>');
    expect(row?.content_html).not.toMatch(
      /<script|<iframe|<svg|<style|<meta|\son\w+\s*=|(?:href|src|srcset)\s*=\s*"?[^"]*javascript:/i
    );
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';

let db: D1Database, env: Env, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };

beforeEach(async () => {
  ({ db, env, dispose } = await createTestDb());
  await db
    .prepare(
      "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@example.com', 1, 'owner', 1, 1)"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO posts (id, slug, title, excerpt, content_html, status, author_id, created_at, updated_at) VALUES ('post1', 'hello', 'Hello', '', '<p>one</p>', 'draft', 'owner', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO pages (id, slug, title, content_html, created_at, updated_at) VALUES ('page1', 'about', 'About', '<p>one</p>', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
    )
    .run();
});
afterEach(async () => {
  await dispose();
});

const postPayload = (title: string, expectedUpdatedAt?: string) => ({
  id: 'post1',
  slug: 'hello',
  title,
  excerpt: '',
  contentHtml: `<p>${title}</p>`,
  contentJson: '',
  status: 'draft',
  seoTitle: '',
  seoDescription: '',
  tags: '',
  coverMediaId: '',
  publishedAt: '',
  ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
});

describe('FF-07: editorial saves carry an atomic version guard', () => {
  it('two blog saves from the same loaded version produce one success and one conflict', async () => {
    const loaded = '2026-01-01T00:00:00.000Z';
    const [a, b] = await Promise.all([
      runAdminAction(db, env, owner, 'post.save', postPayload('First writer', loaded)),
      runAdminAction(db, env, owner, 'post.save', postPayload('Second writer', loaded)),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok);
    expect(loser && !loser.ok && loser.conflict).toBe(true);
    const stored = await db
      .prepare('SELECT title FROM posts WHERE id = ?')
      .bind('post1')
      .first<{ title: string }>();
    expect(['First writer', 'Second writer']).toContain(stored?.title);
    const audits = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'post.save'")
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it('two page saves from the same loaded version produce one success and one conflict', async () => {
    const loaded = '2026-01-01T00:00:00.000Z';
    const payload = (title: string) => ({
      id: 'page1',
      slug: 'about',
      title,
      contentHtml: `<p>${title}</p>`,
      seoTitle: '',
      seoDescription: '',
      expectedUpdatedAt: loaded,
    });
    const [a, b] = await Promise.all([
      runAdminAction(db, env, owner, 'page.save', payload('First page')),
      runAdminAction(db, env, owner, 'page.save', payload('Second page')),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    const audits = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'page.save'")
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it('a save without a loaded version still works for non-editor callers', async () => {
    const result = await runAdminAction(db, env, owner, 'post.save', postPayload('Legacy save'));
    expect(result.ok).toBe(true);
  });
});

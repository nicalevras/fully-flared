import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';
import { plainTextFromHtml, sanitizeHtml } from '../web/src/server/sanitize';

let db: D1Database, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };
const env = {} as Cloudflare.Env;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db);
});
afterEach(async () => {
  await dispose();
});

const update = (payload: Record<string, unknown>) =>
  runAdminAction(db, env, owner, 'product.update', {
    productId: 'p1',
    title: 'Tee',
    slug: 'tee',
    description: 'plain fallback',
    status: 'active',
    ...payload,
  });

describe('Phase 4B rich product descriptions', () => {
  it('derives plain text from sanitized html', () => {
    expect(plainTextFromHtml('<p>Hello <strong>world</strong></p><p>Second line</p>')).toBe(
      'Hello world\nSecond line'
    );
  });

  it('stores sanitized html and derived plain text together', async () => {
    const result = await update({
      descriptionHtml: '<p>Soft <em>cotton</em></p><script>alert(1)</script>',
    });
    expect(result.ok).toBe(true);
    const row = await db
      .prepare('SELECT description, description_html FROM products WHERE id = ?')
      .bind('p1')
      .first<{ description: string; description_html: string }>();
    expect(row?.description_html).toContain('<em>cotton</em>');
    expect(row?.description_html).not.toContain('script');
    expect(row?.description).toBe('Soft cotton');
  });

  it('keeps legacy plain text literal when no html is sent', async () => {
    const result = await update({ description: 'Literal <angle> & text' });
    expect(result.ok).toBe(true);
    const row = await db
      .prepare('SELECT description, description_html FROM products WHERE id = ?')
      .bind('p1')
      .first<{ description: string; description_html: string | null }>();
    expect(row?.description).toBe('Literal <angle> & text');
    expect(row?.description_html).toBeNull();
  });

  it('clears html when an empty html value is sent', async () => {
    expect((await update({ descriptionHtml: '<p>Rich</p>' })).ok).toBe(true);
    expect((await update({ descriptionHtml: '', description: 'Back to plain' })).ok).toBe(true);
    const row = await db
      .prepare('SELECT description, description_html FROM products WHERE id = ?')
      .bind('p1')
      .first<{ description: string; description_html: string | null }>();
    expect(row?.description).toBe('Back to plain');
    expect(row?.description_html).toBeNull();
  });

  it('sanitizer strips unsafe urls from stored html', () => {
    const clean = sanitizeHtml('<a href="javascript:alert(1)">x</a><p>ok</p>');
    expect(clean).not.toContain('javascript:');
    expect(clean).toContain('<p>ok</p>');
  });
});

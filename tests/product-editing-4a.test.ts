import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';
import { productDocumentSchema } from '../web/src/server/catalog-models';

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

async function revision(): Promise<number> {
  const row = await db
    .prepare(
      "SELECT target_revision FROM catalog_work WHERE entity_type = 'product' AND entity_id = 'p1'"
    )
    .first<{ target_revision: number }>();
  return row?.target_revision ?? 0;
}

const update = (expectedRevision?: number, title = 'Renamed Tee') =>
  runAdminAction(db, env, owner, 'product.update', {
    productId: 'p1',
    title,
    slug: 'tee',
    description: '',
    status: 'active',
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  });

describe('Phase 4A reviewed product save', () => {
  it('saves with the opened revision and returns the accepted revision', async () => {
    const opened = await revision();
    const result = await update(opened);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { revision: number; publication: string };
      expect(data.publication).toBe('pending');
      expect(data.revision).toBeGreaterThan(opened);
    }
    const row = await db.prepare("SELECT title FROM products WHERE id = 'p1'").first();
    expect(row?.title).toBe('Renamed Tee');
  });

  it('stores the plain description verbatim and publishes no rich description', async () => {
    const description = 'First line.\n\nSecond paragraph with <b>literal</b> text.';
    const result = await runAdminAction(db, env, owner, 'product.update', {
      productId: 'p1',
      title: 'Tee',
      slug: 'tee',
      description,
      status: 'active',
    });
    expect(result.ok).toBe(true);
    const row = await db
      .prepare("SELECT description, description_text FROM products WHERE id = 'p1'")
      .first<{ description: string; description_text: string }>();
    expect(row?.description).toBe(description);
    expect(row?.description_text).toBe(description);
    expect(productDocumentSchema.shape).not.toHaveProperty('descriptionHtml');
  });

  it('rejects a stale revision and keeps the first save', async () => {
    const opened = await revision();
    expect((await update(opened, 'First Save')).ok).toBe(true);
    const stale = await update(opened, 'Second Save');
    expect(stale.ok).toBe(false);
    if (!stale) expect(stale.conflict).toBe(true);
    const row = await db.prepare("SELECT title FROM products WHERE id = 'p1'").first();
    expect(row?.title).toBe('First Save');
  });

  it('reports a deleted product instead of recreating it', async () => {
    const result = await runAdminAction(db, env, owner, 'product.update', {
      productId: 'deleted-product',
      title: 'Ghost',
      slug: 'ghost',
      description: '',
      status: 'draft',
      expectedRevision: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no longer exists');
    const row = await db.prepare("SELECT id FROM products WHERE id = 'deleted-product'").first();
    expect(row).toBeNull();
  });

  it('bumps product updated_at when a variant changes', async () => {
    await db
      .prepare("UPDATE products SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = 'p1'")
      .run();
    await db.prepare("UPDATE variants SET price_cents = 2500 WHERE product_id = 'p1'").run();
    const row = await db
      .prepare('SELECT updated_at FROM products WHERE id = ?')
      .bind('p1')
      .first<{ updated_at: string }>();
    expect(row?.updated_at).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('does not bump product updated_at when stock changes, so stock never dirties publication', async () => {
    await db
      .prepare("UPDATE products SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = 'p1'")
      .run();
    const beforeRevision = await revision();
    await db.prepare("UPDATE stock SET on_hand = on_hand + 3 WHERE sku = 'TEE-1'").run();
    const row = await db
      .prepare('SELECT updated_at FROM products WHERE id = ?')
      .bind('p1')
      .first<{ updated_at: string }>();
    expect(row?.updated_at).toBe('2000-01-01T00:00:00.000Z');
    expect(await revision()).toBe(beforeRevision);
  });
});

describe('product editor presentation remediation (FF-12, FF-15)', () => {
  it('labels prices without a currency suffix and blocks internal navigation while dirty', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('web/src/components/ProductEditor.tsx', 'utf8');
    expect(source).not.toContain('Price ($)');
    expect(source).not.toContain('Compare at ($)');
    expect(source).not.toContain('({currency})');
    expect(source).toContain('useBlocker');
    expect(source).toContain("blocker.status === 'blocked'");
  });

  it('places images first inside Details with no standalone Images section', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('web/src/components/ProductEditor.tsx', 'utf8');
    expect(source).not.toContain('value="images"');
    const details = source.indexOf('value="details"');
    const images = source.indexOf('>Images</p>');
    const title = source.indexOf('id="e-title"');
    expect(details).toBeGreaterThan(-1);
    expect(images).toBeGreaterThan(details);
    expect(title).toBeGreaterThan(images);
  });
});

describe('product description rich text', () => {
  it('uses the shared expandable rich editor with no description textarea or mode switcher', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('web/src/components/ProductEditor.tsx', 'utf8');
    expect(source).toContain('ExpandableEditor');
    expect(source).toContain("await import('./ExpandableEditor')");
    expect(source).toContain('<Suspense');
    expect(source).not.toContain('id="e-desc"');
    expect(source.toLowerCase()).not.toContain('rich text mode');
    expect(source.toLowerCase()).not.toContain('plain text mode');
  });

  it('sanitizes HTML descriptions on save and keeps allowed formatting and images', async () => {
    const result = await runAdminAction(db, env, owner, 'product.update', {
      productId: 'p1',
      title: 'Tee',
      slug: 'tee',
      description:
        '<p>Hello <strong>world</strong></p><script>alert(1)</script><p><img src="/media/tee.jpg" alt="Tee"></p>',
      status: 'active',
    });
    expect(result.ok).toBe(true);
    const row = await db
      .prepare("SELECT description, description_text FROM products WHERE id = 'p1'")
      .first<{ description: string; description_text: string }>();
    expect(row?.description_text).toBe('Hello world');
    expect(row?.description).toContain('<strong>world</strong>');
    expect(row?.description).toContain('/media/tee.jpg');
    expect(row?.description).not.toContain('<script');
    expect(row?.description).not.toContain('alert(1)');
  });

  it('saves an image-only description as rich text, not literal tag text', async () => {
    const result = await runAdminAction(db, env, owner, 'product.update', {
      productId: 'p1',
      title: 'Tee',
      slug: 'tee',
      description: '<img src="/media/tee.jpg" alt="Tee">',
      status: 'active',
    });
    expect(result.ok).toBe(true);
    const row = await db
      .prepare("SELECT description, description_text FROM products WHERE id = 'p1'")
      .first<{ description: string; description_text: string }>();
    expect(row?.description).toContain('<img');
    expect(row?.description).toContain('/media/tee.jpg');
    expect(row?.description_text).toBe('');
  });

  it('converts plain text to editor HTML and strips HTML back to plain text', async () => {
    const { plainTextToRichHtml, richHtmlToPlainText, isRichTextHtml } =
      await import('../web/src/lib/rich-text');
    expect(plainTextToRichHtml('One\n\nTwo\nlines')).toBe('<p>One</p><p>Two<br>lines</p>');
    expect(plainTextToRichHtml('<p>Already</p>')).toBe('<p>Already</p>');
    expect(richHtmlToPlainText('<p>Hello <strong>world</strong></p><p>Again</p>')).toBe(
      'Hello world Again'
    );
    expect(richHtmlToPlainText('Plain & simple')).toBe('Plain & simple');
    expect(isRichTextHtml('<p>x</p>')).toBe(true);
    expect(isRichTextHtml('a < b')).toBe(false);
    expect(isRichTextHtml('Use <b>tags</b> and <i>this</i>')).toBe(false);
    expect(isRichTextHtml('<strong>hi</strong>')).toBe(false);
    expect(isRichTextHtml('  <h2>Hi</h2>')).toBe(true);
    expect(isRichTextHtml('<ul><li>x</li></ul>')).toBe(true);
    expect(plainTextToRichHtml('Use <b> tags')).toBe('<p>Use &lt;b&gt; tags</p>');
    expect(plainTextToRichHtml('See <a href="https://example.com">this</a> now')).toBe(
      '<p>See &lt;a href=&quot;https://example.com&quot;&gt;this&lt;/a&gt; now</p>'
    );
    expect(richHtmlToPlainText('Use <b>literal</b> text')).toBe('Use <b>literal</b> text');
    // An image is a block node in the editor, so an image-first
    // description is rich text even though it starts with <img>.
    expect(isRichTextHtml('<img src="/media/x.jpg" alt="X">')).toBe(true);
    expect(isRichTextHtml('<img src="/media/x.jpg"><p>Hello</p>')).toBe(true);
    expect(plainTextToRichHtml('<img src="/media/x.jpg" alt="X">')).toBe(
      '<img src="/media/x.jpg" alt="X">'
    );
    expect(richHtmlToPlainText('<img src="/media/x.jpg" alt="X">')).toBe('');
  });
});

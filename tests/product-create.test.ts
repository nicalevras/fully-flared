import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  emptyProductCreateDraft,
  productCreatePayload,
  productCreateServerField,
  suggestedProductSlug,
  validateProductCreateDraft,
  type ProductCreateDraft,
} from '../web/src/lib/product-create';

const valid: ProductCreateDraft = {
  ...emptyProductCreateDraft,
  title: 'Everyday Tote',
  sku: 'TOTE-001',
  price: '29.99',
  stock: '10',
};

describe('product creation draft', () => {
  it('suggests a slug from the title', () => {
    expect(suggestedProductSlug('  Everyday Tote! 2026 ')).toBe('everyday-tote-2026');
  });

  it('accepts a complete draft and builds the existing create payload', () => {
    expect(validateProductCreateDraft(valid)).toEqual({});
    expect(productCreatePayload(valid)).toMatchObject({
      title: 'Everyday Tote',
      slug: 'everyday-tote',
      status: 'draft',
      variants: [{ sku: 'TOTE-001', priceCents: 2999, stock: 10, weightGrams: null }],
    });
  });

  it('reports field errors without discarding the draft', () => {
    const errors = validateProductCreateDraft({
      ...valid,
      title: '',
      slug: 'Bad Slug',
      sku: '',
      price: '-1',
      stock: '1.5',
    });
    expect(errors.title).toBeTruthy();
    expect(errors.slug).toBeTruthy();
    expect(errors.sku).toBeTruthy();
    expect(errors.price).toBeTruthy();
    expect(errors.stock).toBeTruthy();
  });

  it('rejects prices that are not exact cent amounts', () => {
    for (const price of ['29.999', '1e2', '-1', '', 'abc', '1000000.01']) {
      expect(validateProductCreateDraft({ ...valid, price }).price, price).toBeTruthy();
    }
  });

  it('accepts exact prices and carries their cents into the payload', () => {
    for (const [price, cents] of [
      ['0', 0],
      ['0.00', 0],
      ['29.99', 2999],
      ['1000000.00', 100_000_000],
    ] as const) {
      const draft = { ...valid, price };
      expect(validateProductCreateDraft(draft)).toEqual({});
      expect(productCreatePayload(draft).variants[0]?.priceCents).toBe(cents);
    }
  });

  it('maps duplicate server errors back to their fields', () => {
    expect(productCreateServerField('A product with slug everyday-tote already exists')).toBe(
      'slug'
    );
    expect(productCreateServerField('SKU TOTE-001 is already in use')).toBe('sku');
    expect(productCreateServerField('Something else failed')).toBeNull();
  });
});

describe('product creation confirmation (FF-01)', () => {
  it('uses the shared ConfirmDialog, never window.confirm', () => {
    const source = readFileSync('web/src/components/ProductCreateSheet.tsx', 'utf8');
    expect(source).not.toContain('window.confirm');
    expect(source).toContain('ConfirmDialog');
    expect(source).toContain('pendingGroups');
  });

  it('uses the shared expandable rich editor with no description textarea or mode switcher', () => {
    const source = readFileSync('web/src/components/ProductCreateSheet.tsx', 'utf8');
    expect(source).toContain('ExpandableEditor');
    expect(source).toContain("await import('./ExpandableEditor')");
    expect(source).toContain('<Suspense');
    expect(source).not.toContain('id="new-description"');
    expect(source.toLowerCase()).not.toContain('rich text mode');
    expect(source.toLowerCase()).not.toContain('plain text mode');
  });

  it('places images first inside Details with no standalone Images section', () => {
    const source = readFileSync('web/src/components/ProductCreateSheet.tsx', 'utf8');
    expect(source).not.toContain('value="images"');
    const details = source.indexOf('value="product-details"');
    const images = source.indexOf('>Images</p>');
    const title = source.indexOf('id="new-title"');
    expect(details).toBeGreaterThan(-1);
    expect(images).toBeGreaterThan(details);
    expect(title).toBeGreaterThan(images);
  });
});

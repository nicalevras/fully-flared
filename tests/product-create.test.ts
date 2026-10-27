import { describe, expect, it } from 'vitest';
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

  it('maps duplicate server errors back to their fields', () => {
    expect(productCreateServerField('A product with slug everyday-tote already exists')).toBe(
      'slug'
    );
    expect(productCreateServerField('SKU TOTE-001 is already in use')).toBe('sku');
    expect(productCreateServerField('Something else failed')).toBeNull();
  });
});

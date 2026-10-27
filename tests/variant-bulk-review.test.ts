import { describe, expect, it } from 'vitest';
import { buildBulkPriceReview } from '../web/src/lib/variant-bulk-review';

const variants = [
  { id: 'v1', sku: 'TEE-S', title: 'Small', price_cents: 2000 },
  { id: 'v2', sku: 'TEE-L', title: 'Large', price_cents: 2200 },
];

describe('bulk variant price review', () => {
  it('shows old and new prices for every selected variant before applying', () => {
    const review = buildBulkPriceReview(variants, ['v1', 'v2'], 2500);
    expect(review.errors).toEqual([]);
    expect(review.rows).toEqual([
      { id: 'v1', sku: 'TEE-S', title: 'Small', oldPriceCents: 2000, newPriceCents: 2500 },
      { id: 'v2', sku: 'TEE-L', title: 'Large', oldPriceCents: 2200, newPriceCents: 2500 },
    ]);
  });

  it('rejects an empty selection and a missing price', () => {
    expect(buildBulkPriceReview(variants, [], 2500).errors).toContain('Select at least one variant.');
    expect(buildBulkPriceReview(variants, ['v1'], null).errors).toContain('Enter a price of zero or more.');
  });

  it('rejects a selection past the bounded cap', () => {
    const many = Array.from({ length: 51 }, (_, i) => `v${i}`);
    expect(buildBulkPriceReview(variants, many, 100).errors.join(' ')).toContain('capped at 50');
  });
});

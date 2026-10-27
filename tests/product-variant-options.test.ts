import { describe, expect, it } from 'vitest';
import {
  countCombinations,
  generateVariantCombinations,
  validateVariantCombinations,
} from '../web/src/lib/product-variant-options';

const groups = [
  { name: 'Size', values: ['Small', 'Medium', 'Large'] },
  { name: 'Color', values: ['Black', 'White'] },
];

describe('variant option combinations', () => {
  it('previews six combinations for 3 sizes by 2 colors', () => {
    expect(countCombinations(groups)).toBe(6);
    const combos = generateVariantCombinations(groups, 'everyday-tote', {
      price: '29.99',
      stock: '5',
    });
    expect(combos).toHaveLength(6);
    expect(combos[0]).toMatchObject({ title: 'Small / Black', sku: 'EVERYDAY-TOTE-SMALL-BLACK' });
    expect(combos[5]).toMatchObject({ title: 'Large / White', sku: 'EVERYDAY-TOTE-LARGE-WHITE' });
  });

  it('preserves entered values for combinations that survive an option change', () => {
    const first = generateVariantCombinations(groups, 'tote', { price: '29.99', stock: '5' });
    first[0] = { ...first[0], sku: 'CUSTOM-1', price: '31.00' };
    const next = generateVariantCombinations(
      [
        { name: 'Size', values: ['Small', 'Medium'] },
        { name: 'Color', values: ['Black', 'White'] },
      ],
      'tote',
      { price: '29.99', stock: '5' },
      first
    );
    expect(next.find((combo) => combo.title === 'Small / Black')).toMatchObject({
      sku: 'CUSTOM-1',
      price: '31.00',
    });
  });

  it('rejects duplicate SKUs before submission', () => {
    const combos = generateVariantCombinations(groups, 'tote', { price: '10', stock: '1' });
    combos[1] = { ...combos[1], sku: combos[0].sku };
    expect(validateVariantCombinations(combos).join(' ')).toContain('used more than once');
  });

  it('returns no combinations when the bound would be exceeded', () => {
    const huge = [
      { name: 'Size', values: Array.from({ length: 10 }, (_, i) => `S${i}`) },
      { name: 'Color', values: Array.from({ length: 10 }, (_, i) => `C${i}`) },
      { name: 'Fit', values: ['A', 'B'] },
    ];
    expect(countCombinations(huge)).toBe(200);
    expect(generateVariantCombinations(huge, 'tote', { price: '1', stock: '0' })).toEqual([]);
  });
});

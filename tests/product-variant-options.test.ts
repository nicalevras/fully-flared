import { describe, expect, it } from 'vitest';
import { at } from './helpers/fixtures';
import {
  countCombinations,
  droppedEditedCombinations,
  generateVariantCombinations,
  parseOptionValues,
  validateOptionGroups,
  validateVariantCombinations,
} from '../web/src/lib/product-variant-options';

const groups = [
  { name: 'Size', valuesText: 'Small, Medium, Large' },
  { name: 'Color', valuesText: 'Black, White' },
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

  it('keeps trailing separators as text while parsing complete values', () => {
    expect(parseOptionValues('Small, Medium,')).toEqual(['Small', 'Medium']);
    expect(parseOptionValues('  Small ,, Medium ')).toEqual(['Small', 'Medium']);
    expect(countCombinations([{ name: 'Size', valuesText: 'Small, Medium,' }])).toBe(2);
  });

  it('preserves entered values for combinations that survive an option change', () => {
    const first = generateVariantCombinations(groups, 'tote', { price: '29.99', stock: '5' });
    first[0] = { ...at(first, 0), sku: 'CUSTOM-1', price: '31.00' };
    const next = generateVariantCombinations(
      [
        { name: 'Size', valuesText: 'Small, Medium' },
        { name: 'Color', valuesText: 'Black, White' },
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
    combos[1] = { ...at(combos, 1), sku: at(combos, 0).sku };
    expect(validateVariantCombinations(combos).join(' ')).toContain('used more than once');
  });

  it('returns no combinations when the bound would be exceeded', () => {
    const huge = [
      { name: 'Size', valuesText: Array.from({ length: 10 }, (_, i) => `S${i}`).join(',') },
      { name: 'Color', valuesText: Array.from({ length: 10 }, (_, i) => `C${i}`).join(',') },
      { name: 'Fit', valuesText: 'A, B' },
    ];
    expect(countCombinations(huge)).toBe(200);
    expect(generateVariantCombinations(huge, 'tote', { price: '1', stock: '0' })).toEqual([]);
    expect(validateVariantCombinations([], 200).join(' ')).toContain(
      '200 combinations exceed the limit of 100'
    );
  });

  it('rejects duplicate group names, duplicate values and extra values', () => {
    expect(
      validateOptionGroups([
        { name: 'Color', valuesText: 'Black' },
        { name: 'color', valuesText: 'White' },
      ]).join(' ')
    ).toContain('Option names must be unique.');
    expect(
      validateOptionGroups([{ name: 'Color', valuesText: 'Black, black' }]).join(' ')
    ).toContain('Values in Color must be unique.');
    expect(
      validateOptionGroups([
        {
          name: 'Size',
          valuesText: Array.from({ length: 11 }, (_, i) => `S${i}`).join(','),
        },
      ]).join(' ')
    ).toContain('Option Size has more than 10 values.');
  });

  it('rejects generated SKUs and titles that exceed server limits', () => {
    const longSku = generateVariantCombinations(
      [{ name: 'Size', valuesText: 'X'.repeat(120) }],
      'p'.repeat(60),
      { price: '1', stock: '0' }
    );
    expect(validateVariantCombinations(longSku).join(' ')).toContain('SKU over 100 characters');
    const longTitle = [
      {
        key: 'k',
        title: 'T'.repeat(201),
        values: ['T'],
        sku: 'SKU-1',
        price: '1',
        compareAt: '',
        stock: '0',
      },
    ];
    expect(validateVariantCombinations(longTitle).join(' ')).toContain('title over 200 characters');
  });

  it('rejects inexact and over-limit combination prices', () => {
    const combos = generateVariantCombinations(groups, 'tote', { price: '29.999', stock: '1' });
    expect(validateVariantCombinations(combos).join(' ')).toContain('at most two decimal places');
    combos[0] = { ...at(combos, 0), price: '1000000.01' };
    expect(validateVariantCombinations(combos).join(' ')).toContain('Small / Black');
  });

  it('flags only edited combinations that a change would drop', () => {
    const first = generateVariantCombinations(groups, 'tote', { price: '10', stock: '1' });
    const next = generateVariantCombinations(
      [
        { name: 'Size', valuesText: 'Small, Medium' },
        { name: 'Color', valuesText: 'Black, White' },
      ],
      'tote',
      { price: '10', stock: '1' },
      first
    );
    const edited = new Set([at(first, 0).key, at(first, 5).key]);
    expect(droppedEditedCombinations(first, edited, next).map((combo) => combo.title)).toEqual([
      'Large / White',
    ]);
    expect(droppedEditedCombinations(first, new Set(), next)).toEqual([]);
  });
});

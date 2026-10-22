import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { reorderItems, type ReorderItem } from '../web/src/lib/reorder';

const items: ReorderItem[] = [
  { sku: 'TEE-1', title: 'Tee', qty: 1 },
  { sku: 'OLD-1', title: 'Old hat', qty: 2 },
  { sku: 'MUG-1', title: 'Mug', qty: 1 },
];

describe('reorderItems', () => {
  it('adds every item when all succeed', async () => {
    const result = await reorderItems(items, async () => {});
    expect(result.added.map((i) => i.sku)).toEqual(['TEE-1', 'OLD-1', 'MUG-1']);
    expect(result.failed).toEqual([]);
  });

  it('an unavailable item fails as unavailable and later items still add', async () => {
    const result = await reorderItems(items, async (sku) => {
      if (sku === 'OLD-1') throw new Error('Item is no longer available');
    });
    expect(result.added.map((i) => i.sku)).toEqual(['TEE-1', 'MUG-1']);
    expect(result.failed).toEqual([{ title: 'Old hat', unavailable: true }]);
  });

  it('limit and network failures are generic, not unavailable', async () => {
    const limited = await reorderItems(items, async (sku) => {
      if (sku === 'TEE-1') throw new Error('Cart is limited to 20 lines');
      if (sku === 'MUG-1') throw new TypeError('Failed to fetch');
    });
    expect(limited.failed).toEqual([
      { title: 'Tee', unavailable: false },
      { title: 'Mug', unavailable: false },
    ]);
    expect(limited.added.map((i) => i.sku)).toEqual(['OLD-1']);
  });

  it('account page wires the helper, message, and conditional cart opening', () => {
    const page = readFileSync('web/src/routes/_shop.account/index.tsx', 'utf8');
    expect(page).toContain('reorderItems(o.items, addToCart)');
    expect(page).toContain('No longer available:');
    expect(page).toContain("Couldn't add:");
    expect(page).toContain('if (added.length > 0) openCart();');
  });
});

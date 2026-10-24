import { describe, expect, it } from 'vitest';
import { applyVariantEdits } from '../web/src/lib/variant-edits';

type Row = { id: string; sku: string; price_cents: number; on_hand: number };

const first: Row = { id: 'v1', sku: 'TOTE-1', price_cents: 2999, on_hand: 4 };
const second: Row = { id: 'v2', sku: 'TOTE-2', price_cents: 3499, on_hand: 9 };

describe('applyVariantEdits', () => {
  it('shows loader rows untouched when nothing is edited', () => {
    expect(applyVariantEdits([first, second], {})).toEqual([first, second]);
  });

  it('keeps an unsaved edit on one row and takes stock from the refreshed loader', () => {
    const refreshed = { ...first, on_hand: 14 };
    expect(applyVariantEdits([refreshed, second], { v2: { price_cents: 100 } })).toEqual([
      refreshed,
      { ...second, price_cents: 100 },
    ]);
  });

  it('shows a variant added after the first render', () => {
    const added: Row = { id: 'v3', sku: 'TOTE-3', price_cents: 1000, on_hand: 0 };
    const rows = applyVariantEdits([first, second, added], { v1: { sku: 'X' } });
    expect(rows.map((row) => row.id)).toEqual(['v1', 'v2', 'v3']);
  });

  it('drops a deleted variant even when it had an unsaved edit', () => {
    const rows = applyVariantEdits([second], { v1: { sku: 'X' }, v2: { sku: 'Y' } });
    expect(rows).toEqual([{ ...second, sku: 'Y' }]);
  });
});

export type StockReason = 'restock' | 'correction' | 'damaged' | 'return';

export const STOCK_REASONS: ReadonlyArray<{ value: StockReason; label: string }> = [
  { value: 'restock', label: 'Restock' },
  { value: 'correction', label: 'Correction' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'return', label: 'Return' },
];

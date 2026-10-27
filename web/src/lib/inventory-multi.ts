export const MAX_MULTI_ADJUSTMENTS = 20;

export type MultiAdjustmentStatus = 'pending' | 'applied' | 'failed';

export type MultiAdjustmentItem = {
  sku: string;
  delta: number;
  reason: string;
  note: string;
  operationId: string;
  status: MultiAdjustmentStatus;
  message: string;
};

export function parseMultiAdjustments(
  text: string,
  shared: { reason: string; note: string },
  makeId: () => string
): { items: MultiAdjustmentItem[]; errors: string[] } {
  const errors: string[] = [];
  const items: MultiAdjustmentItem[] = [];
  const seen = new Set<string>();
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { items, errors: ['Enter at least one SKU and amount.'] };
  if (lines.length > MAX_MULTI_ADJUSTMENTS) {
    return {
      items,
      errors: [`Adjust at most ${MAX_MULTI_ADJUSTMENTS} SKUs at once.`],
    };
  }
  for (const line of lines) {
    const parts = line.split(/[,\s]+/).filter(Boolean);
    if (parts.length !== 2) {
      errors.push(`Could not read "${line}". Use SKU, amount on each line.`);
      continue;
    }
    const [sku, rawDelta] = parts as [string, string];
    const delta = Number(rawDelta);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000) {
      errors.push(`Amount for ${sku} must be a whole number other than zero.`);
      continue;
    }
    if (seen.has(sku)) {
      errors.push(`SKU ${sku} appears more than once. Combine its amounts into one line.`);
      continue;
    }
    seen.add(sku);
    items.push({
      sku,
      delta,
      reason: shared.reason,
      note: shared.note,
      operationId: makeId(),
      status: 'pending',
      message: '',
    });
  }
  return { items: errors.length > 0 ? [] : items, errors };
}

export function retryableItems(items: MultiAdjustmentItem[]): MultiAdjustmentItem[] {
  return items.filter((item) => item.status !== 'applied');
}

export function summarizeMulti(items: MultiAdjustmentItem[]): {
  total: number;
  applied: number;
  failed: number;
  pending: number;
  partial: boolean;
  complete: boolean;
} {
  const applied = items.filter((item) => item.status === 'applied').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const pending = items.filter((item) => item.status === 'pending').length;
  return {
    total: items.length,
    applied,
    failed,
    pending,
    partial: applied > 0 && failed > 0,
    complete: items.length > 0 && pending === 0 && failed === 0,
  };
}

export function applyMultiOutcome(
  items: MultiAdjustmentItem[],
  sku: string,
  outcome: { ok: boolean; message: string }
): MultiAdjustmentItem[] {
  return items.map((item) =>
    item.sku === sku
      ? { ...item, status: outcome.ok ? 'applied' : 'failed', message: outcome.message }
      : item
  );
}

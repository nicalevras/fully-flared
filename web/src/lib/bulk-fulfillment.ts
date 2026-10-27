export const MAX_BULK_FULFILLMENT = 10;

export type BulkFulfillmentStatus = 'pending' | 'applied' | 'failed';

export type BulkFulfillmentItem = {
  orderId: string;
  number: string;
  tracking: string;
  status: BulkFulfillmentStatus;
  message: string;
};

export function createBulkItems(
  rows: Array<{ id: string; number: string }>,
  existing: BulkFulfillmentItem[] = []
): { items: BulkFulfillmentItem[]; error: string | null } {
  if (rows.length === 0) return { items: [], error: 'Select at least one order.' };
  if (rows.length > MAX_BULK_FULFILLMENT) {
    return {
      items: [],
      error: `Ship at most ${MAX_BULK_FULFILLMENT} orders at once. Narrow the selection.`,
    };
  }
  const byId = new Map(existing.map((item) => [item.orderId, item]));
  return {
    items: rows.map((row) => {
      const prior = byId.get(row.id);
      return prior && prior.number === row.number
        ? prior
        : {
            orderId: row.id,
            number: row.number,
            tracking: '',
            status: 'pending' as const,
            message: '',
          };
    }),
    error: null,
  };
}

export function setBulkTracking(
  items: BulkFulfillmentItem[],
  orderId: string,
  tracking: string
): BulkFulfillmentItem[] {
  return items.map((item) =>
    item.orderId === orderId && item.status !== 'applied'
      ? { ...item, tracking, status: 'pending' as const, message: '' }
      : item
  );
}

export function bulkTrackingErrors(items: BulkFulfillmentItem[]): string[] {
  return items
    .filter((item) => item.status !== 'applied' && item.tracking.trim() === '')
    .map((item) => `${item.number} needs a tracking number.`);
}

export function retryableBulkItems(items: BulkFulfillmentItem[]): BulkFulfillmentItem[] {
  return items.filter((item) => item.status !== 'applied');
}

export function applyBulkOutcome(
  items: BulkFulfillmentItem[],
  orderId: string,
  outcome: { ok: boolean; message: string }
): BulkFulfillmentItem[] {
  return items.map((item) =>
    item.orderId === orderId
      ? { ...item, status: outcome.ok ? 'applied' : 'failed', message: outcome.message }
      : item
  );
}

export function summarizeBulk(items: BulkFulfillmentItem[]): {
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

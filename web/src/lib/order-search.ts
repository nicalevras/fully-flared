export const orderViews = ['queue', 'all', 'payment-issues', 'returns'] as const;

export type OrderView = (typeof orderViews)[number];

export const orderPaymentFilters = [
  'all',
  'unpaid',
  'paid',
  'failed',
  'refunded',
  'partially_refunded',
  'disputed',
] as const;

export type OrderPaymentFilter = (typeof orderPaymentFilters)[number];

export type OrderSearch = {
  q: string;
  view: OrderView;
  payment: OrderPaymentFilter;
  from: string;
  to: string;
  cursor?: string | undefined;
};

export type OrderSearchCursor = {
  key: string;
  id: string;
  direction: 'next' | 'previous';
};

export function isOrderView(value: unknown): value is OrderView {
  return typeof value === 'string' && (orderViews as readonly string[]).includes(value);
}

export function isOrderPaymentFilter(value: unknown): value is OrderPaymentFilter {
  return typeof value === 'string' && (orderPaymentFilters as readonly string[]).includes(value);
}

function dateValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

export function decodeOrderSearchCursor(
  cursor: string | undefined,
  search: Omit<OrderSearch, 'cursor'>
): OrderSearchCursor | null {
  if (!cursor) return null;
  try {
    const bytes = Uint8Array.from(atob(cursor), (character) => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.v !== 1) return null;
    if (record.direction !== 'next' && record.direction !== 'previous') return null;
    if (
      record.q !== search.q ||
      record.view !== search.view ||
      record.payment !== search.payment ||
      record.from !== search.from ||
      record.to !== search.to
    )
      return null;
    if (typeof record.key !== 'string' || typeof record.id !== 'string') return null;
    return { key: record.key, id: record.id, direction: record.direction };
  } catch {
    return null;
  }
}

export function normalizeOrderSearch(value: unknown): OrderSearch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { q: '', view: 'queue', payment: 'all', from: '', to: '' };
  }
  const raw = value as Record<string, unknown>;
  const base: Omit<OrderSearch, 'cursor'> = {
    q: typeof raw.q === 'string' && raw.q.length <= 200 ? raw.q.trim() : '',
    view: isOrderView(raw.view) ? raw.view : 'queue',
    payment: isOrderPaymentFilter(raw.payment) ? raw.payment : 'all',
    from: dateValue(raw.from),
    to: dateValue(raw.to),
  };
  const cursor =
    typeof raw.cursor === 'string' &&
    raw.cursor.length <= 2000 &&
    decodeOrderSearchCursor(raw.cursor, base)
      ? raw.cursor
      : undefined;
  return { ...base, cursor };
}

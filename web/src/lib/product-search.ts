export const productSearchModes = ['title', 'sku'] as const;

export type ProductMode = (typeof productSearchModes)[number];

export const productStatusFilters = ['all', 'active', 'draft', 'archived'] as const;

export type ProductStatusFilter = (typeof productStatusFilters)[number];

export const productSorts = ['newest', 'oldest', 'title', 'updated'] as const;

export type ProductSort = (typeof productSorts)[number];

export type ProductSearch = {
  q: string;
  mode: ProductMode | null;
  status: ProductStatusFilter;
  sort: ProductSort;
  cursor?: string | undefined;
};

export type ProductSearchCursor = {
  key: string;
  id: string;
  direction: 'next' | 'previous';
};

export function isProductMode(value: unknown): value is ProductMode {
  return typeof value === 'string' && (productSearchModes as readonly string[]).includes(value);
}

export function isProductStatusFilter(value: unknown): value is ProductStatusFilter {
  return typeof value === 'string' && (productStatusFilters as readonly string[]).includes(value);
}

export function isProductSort(value: unknown): value is ProductSort {
  return typeof value === 'string' && (productSorts as readonly string[]).includes(value);
}

export function compareBinaryStrings(a: string, b: string): number {
  const left = Array.from(a, (character) => character.codePointAt(0) ?? 0);
  const right = Array.from(b, (character) => character.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  }
  return left.length - right.length;
}

export function foldProductTitle(title: string): string {
  return title.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export function compareProductTitles(
  a: { title: string; id: string },
  b: { title: string; id: string }
): number {
  return (
    compareBinaryStrings(foldProductTitle(a.title), foldProductTitle(b.title)) ||
    compareBinaryStrings(a.id, b.id)
  );
}

export function decodeProductSearchCursor(
  cursor: string | undefined,
  q: string,
  mode: ProductMode | null,
  status: ProductStatusFilter,
  sort: ProductSort
): ProductSearchCursor | null {
  if (!cursor) return null;
  try {
    const bytes = Uint8Array.from(atob(cursor), (character) => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.v !== 2) return null;
    if (record.direction !== 'next' && record.direction !== 'previous') return null;
    if (record.q !== q || record.mode !== mode) return null;
    if (record.status !== status || record.sort !== sort) return null;
    if (typeof record.key !== 'string' || typeof record.id !== 'string') return null;
    return { key: record.key, id: record.id, direction: record.direction };
  } catch {
    return null;
  }
}

export function normalizeProductSearch(value: unknown): ProductSearch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { q: '', mode: null, status: 'all', sort: 'newest' };
  }
  const raw = value as Record<string, unknown>;
  const q = typeof raw.q === 'string' && raw.q.length <= 200 ? raw.q.trim() : '';
  const mode: ProductMode | null = q
    ? isProductMode(raw.mode)
      ? raw.mode
      : typeof raw.mode === 'string' && raw.mode.startsWith('sku')
        ? 'sku'
        : 'title'
    : null;
  const status: ProductStatusFilter = isProductStatusFilter(raw.status) ? raw.status : 'all';
  const sort: ProductSort = isProductSort(raw.sort) ? raw.sort : 'newest';
  const cursor =
    typeof raw.cursor === 'string' &&
    raw.cursor.length <= 2000 &&
    decodeProductSearchCursor(raw.cursor, q, mode, status, sort)
      ? raw.cursor
      : undefined;
  return { q, mode, status, sort, cursor };
}

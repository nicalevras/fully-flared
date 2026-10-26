export const productSearchModes = ['title', 'sku-exact', 'sku-prefix'] as const;

export type ProductMode = (typeof productSearchModes)[number];

export type ProductSearch = {
  q: string;
  mode: ProductMode | null;
  cursor?: string | undefined;
};

export type ProductSearchCursor = {
  createdAt: string;
  id: string;
  direction: 'next' | 'previous';
};

export function isProductMode(value: unknown): value is ProductMode {
  return typeof value === 'string' && (productSearchModes as readonly string[]).includes(value);
}

export function decodeProductSearchCursor(
  cursor: string | undefined,
  q: string,
  mode: ProductMode | null
): ProductSearchCursor | null {
  if (!cursor) return null;
  try {
    const bytes = Uint8Array.from(atob(cursor), (character) => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.v !== 1) return null;
    if (record.direction !== 'next' && record.direction !== 'previous') return null;
    if (record.q !== q || record.mode !== mode) return null;
    if (typeof record.createdAt !== 'string' || typeof record.id !== 'string') return null;
    return { createdAt: record.createdAt, id: record.id, direction: record.direction };
  } catch {
    return null;
  }
}

export function normalizeProductSearch(value: unknown): ProductSearch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { q: '', mode: null };
  }
  const raw = value as Record<string, unknown>;
  const q = typeof raw.q === 'string' && raw.q.length <= 200 ? raw.q.trim() : '';
  const mode: ProductMode | null = q ? (isProductMode(raw.mode) ? raw.mode : 'title') : null;
  const cursor =
    typeof raw.cursor === 'string' &&
    raw.cursor.length <= 2000 &&
    decodeProductSearchCursor(raw.cursor, q, mode)
      ? raw.cursor
      : undefined;
  return { q, mode, cursor };
}

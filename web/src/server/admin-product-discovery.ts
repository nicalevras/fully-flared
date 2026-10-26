import { z } from 'zod';
import type { ProductStatus } from '../db/schema';
import {
  compareBinaryStrings,
  compareProductTitles,
  decodeProductSearchCursor,
  normalizeProductSearch,
  productSearchModes,
  productSorts,
  productStatusFilters,
  type ProductSearchCursor,
  type ProductSort,
} from '../lib/product-search';

export const productModeSchema = z.enum(productSearchModes);
export const productStatusFilterSchema = z.enum(productStatusFilters);
export const productSortSchema = z.enum(productSorts);
export const productDiscoveryInputSchema = z.object({
  q: z.string().max(200).default(''),
  mode: productModeSchema.nullable().default(null),
  status: productStatusFilterSchema.default('all'),
  sort: productSortSchema.default('newest'),
  cursor: z.string().max(2000).optional(),
});
export type ProductDiscoveryInput = z.infer<typeof productDiscoveryInputSchema>;
type Position = ProductSearchCursor;
type Candidate = {
  id: string;
  created_at: string;
  updated_at: string;
  title: string;
  sku?: string | null;
  variant_title?: string | null;
};
export type MatchedSku = { sku: string; title: string };
export type AdminProductRow = {
  id: string;
  slug: string;
  title: string;
  status: ProductStatus;
  created_at: string;
  price_cents: number | null;
  max_price_cents: number | null;
  variant_count: number;
  available: number;
  image_key: string | null;
  matched_skus: MatchedSku[];
  matched_sku_count: number;
};
type DiscoveryResult = {
  products: AdminProductRow[];
  nextCursor: string | null;
  previousCursor: string | null;
  state: 'ready' | 'refine';
};

function sortKey(row: Candidate, sort: ProductSort): string {
  if (sort === 'title') return row.title;
  if (sort === 'updated') return row.updated_at;
  return row.created_at;
}

function encodeCursor(
  input: ProductDiscoveryInput,
  row: Candidate,
  direction: Position['direction']
): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      v: 2,
      q: input.q,
      mode: input.mode,
      status: input.status,
      sort: input.sort,
      direction,
      key: sortKey(row, input.sort),
      id: row.id,
    })
  );
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

function compareCandidates(sort: ProductSort, a: Candidate, b: Candidate): number {
  switch (sort) {
    case 'oldest':
      return compareBinaryStrings(a.created_at, b.created_at) || compareBinaryStrings(a.id, b.id);
    case 'title':
      return compareProductTitles(a, b);
    case 'updated':
      return compareBinaryStrings(b.updated_at, a.updated_at) || compareBinaryStrings(b.id, a.id);
    default:
      return compareBinaryStrings(b.created_at, a.created_at) || compareBinaryStrings(b.id, a.id);
  }
}

function cursorPosition(cursor: Position): Candidate {
  return { id: cursor.id, created_at: cursor.key, updated_at: cursor.key, title: cursor.key };
}

function titleMatch(q: string): string {
  return `title : (${q
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' AND ')})`;
}

function prefixCeiling(prefix: string): string | null {
  const chars = Array.from(prefix);
  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i];
    if (char === undefined) continue;
    const code = char.codePointAt(0);
    if (code === undefined || code >= 0x10ffff) continue;
    const next = code >= 0xd7ff && code < 0xe000 ? 0xe000 : code + 1;
    return chars.slice(0, i).join('') + String.fromCodePoint(next);
  }
  return null;
}

async function discover(db: D1Database, input: ProductDiscoveryInput): Promise<Candidate[]> {
  const statusClause = input.status === 'all' ? '' : 'AND p.status=?';
  const binds: string[] = input.status === 'all' ? [] : [input.status];
  if (input.mode === 'title') {
    return (
      await db
        .prepare(
          `SELECT p.id,p.created_at,p.updated_at,p.title FROM products_fts f
      JOIN products p ON p.rowid=f.rowid WHERE products_fts MATCH ? ${statusClause} LIMIT 1001`
        )
        .bind(titleMatch(input.q), ...binds)
        .all<Candidate>()
    ).results;
  }
  if (input.mode === 'sku-exact') {
    return (
      await db
        .prepare(
          `SELECT p.id,p.created_at,p.updated_at,p.title,v.sku,v.title AS variant_title FROM variants v
      JOIN products p ON p.id=v.product_id WHERE v.sku=? ${statusClause} LIMIT 1001`
        )
        .bind(input.q, ...binds)
        .all<Candidate>()
    ).results;
  }
  const ceiling = prefixCeiling(input.q);
  const query = `SELECT p.id,p.created_at,p.updated_at,p.title,v.sku,v.title AS variant_title FROM variants v JOIN products p ON p.id=v.product_id
    WHERE v.sku>=? ${ceiling ? 'AND v.sku<?' : ''} ${statusClause} LIMIT 1001`;
  const statement = db.prepare(query);
  const skuBinds = ceiling ? [input.q, ceiling, ...binds] : [input.q, ...binds];
  return (await statement.bind(...skuBinds).all<Candidate>()).results;
}

async function project(
  db: D1Database,
  candidates: Candidate[],
  matched?: Map<string, MatchedSku[]>
): Promise<AdminProductRow[]> {
  if (candidates.length === 0) return [];
  const placeholders = candidates.map(() => '?').join(',');
  const result = await db
    .prepare(
      `SELECT p.id,p.slug,p.title,p.status,p.created_at,
    (SELECT MIN(v.price_cents) FROM variants v WHERE v.product_id=p.id AND v.status='active') AS price_cents,
    (SELECT MAX(v.price_cents) FROM variants v WHERE v.product_id=p.id AND v.status='active') AS max_price_cents,
    (SELECT COUNT(*) FROM variants v WHERE v.product_id=p.id) AS variant_count,
    (SELECT COALESCE(SUM(COALESCE(s.on_hand,0)-COALESCE(s.reserved,0)),0) FROM variants v
      LEFT JOIN stock s ON s.sku=v.sku WHERE v.product_id=p.id AND v.status='active') AS available,
    (SELECT m.r2_key FROM product_media pm JOIN media m ON m.id=pm.media_id
      WHERE pm.product_id=p.id AND m.ready=1 AND m.deletion_pending=0
      ORDER BY pm.position LIMIT 1) AS image_key
    FROM products p WHERE p.id IN (${placeholders})`
    )
    .bind(...candidates.map((row) => row.id))
    .all<Omit<AdminProductRow, 'matched_skus' | 'matched_sku_count'>>();
  const byId = new Map(result.results.map((row) => [row.id, row]));
  return candidates.flatMap((row) => {
    const found = byId.get(row.id);
    if (!found) return [];
    const matches = matched?.get(row.id) ?? [];
    return [
      {
        ...found,
        matched_skus: matches.slice(0, 3),
        matched_sku_count: matches.length,
      },
    ];
  });
}

const browseSortSql = {
  newest: { column: 'created_at', descending: true, collate: '' },
  oldest: { column: 'created_at', descending: false, collate: '' },
  title: { column: 'title', descending: false, collate: ' COLLATE NOCASE' },
  updated: { column: 'updated_at', descending: true, collate: '' },
} as const;

async function browse(db: D1Database, input: ProductDiscoveryInput): Promise<Candidate[]> {
  const spec = browseSortSql[input.sort];
  const cursor = decodeProductSearchCursor(
    input.cursor,
    input.q,
    input.mode,
    input.status,
    input.sort
  );
  const previous = cursor?.direction === 'previous';
  const descending = previous ? !spec.descending : spec.descending;
  const direction = descending ? 'DESC' : 'ASC';
  const operator = descending ? '<' : '>';
  const clauses: string[] = [];
  const binds: string[] = [];
  if (input.status !== 'all') {
    clauses.push('status=?');
    binds.push(input.status);
  }
  if (cursor) {
    if (input.sort === 'title') {
      clauses.push(
        `(title COLLATE NOCASE ${operator} ? OR (title COLLATE NOCASE = ? AND id ${operator} ?))`
      );
      binds.push(cursor.key, cursor.key, cursor.id);
    } else {
      clauses.push(`(${spec.column},id) ${operator} (?,?)`);
      binds.push(cursor.key, cursor.id);
    }
  }
  const query = `SELECT id,created_at,updated_at,title FROM products ${
    clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  } ORDER BY ${spec.column}${spec.collate} ${direction},id ${direction} LIMIT 51`;
  const statement = db.prepare(query);
  return (await statement.bind(...binds).all<Candidate>()).results;
}

export async function adminProductDiscovery(
  db: D1Database,
  raw: unknown
): Promise<DiscoveryResult> {
  const input = productDiscoveryInputSchema.parse(normalizeProductSearch(raw));
  const cursor = decodeProductSearchCursor(
    input.cursor,
    input.q,
    input.mode,
    input.status,
    input.sort
  );
  let candidates: Candidate[];
  let matched: Map<string, MatchedSku[]> | undefined;
  if (input.mode === null) {
    candidates = await browse(db, input);
    if (cursor?.direction === 'previous') {
      const hasEarlier = candidates.length > 50;
      const selected = candidates.slice(0, 50).reverse();
      const last = selected.at(-1);
      return {
        products: await project(db, selected),
        nextCursor: last ? encodeCursor(input, last, 'next') : null,
        previousCursor:
          hasEarlier && selected[0] ? encodeCursor(input, selected[0], 'previous') : null,
        state: 'ready',
      };
    }
  } else {
    candidates = await discover(db, input);
    if (candidates.length > 1000)
      return { products: [], nextCursor: null, previousCursor: null, state: 'refine' };
    if (input.mode !== 'title') {
      matched = new Map();
      for (const row of candidates) {
        if (!row.sku) continue;
        const list = matched.get(row.id) ?? [];
        list.push({ sku: row.sku, title: row.variant_title ?? '' });
        matched.set(row.id, list);
      }
      for (const list of matched.values())
        list.sort((a, b) => compareBinaryStrings(a.sku, b.sku));
    }
    candidates = [...new Map(candidates.map((row) => [row.id, row])).values()]
      .sort((a, b) => compareCandidates(input.sort, a, b))
      .filter((row) => {
        if (!cursor) return true;
        const compared = compareCandidates(input.sort, row, cursorPosition(cursor));
        return cursor.direction === 'previous' ? compared < 0 : compared > 0;
      });
    if (cursor?.direction === 'previous') {
      const hasEarlier = candidates.length > 50;
      const selected = candidates.slice(-50);
      const last = selected.at(-1);
      return {
        products: await project(db, selected, matched),
        nextCursor: last ? encodeCursor(input, last, 'next') : null,
        previousCursor:
          hasEarlier && selected[0] ? encodeCursor(input, selected[0], 'previous') : null,
        state: 'ready',
      };
    }
  }
  const selected = candidates.slice(0, 50);
  const products = await project(db, selected, matched);
  const last = selected.at(-1);
  const first = selected[0];
  return {
    products,
    nextCursor: candidates.length > 50 && last ? encodeCursor(input, last, 'next') : null,
    previousCursor:
      cursor?.direction === 'next' && first ? encodeCursor(input, first, 'previous') : null,
    state: 'ready',
  };
}

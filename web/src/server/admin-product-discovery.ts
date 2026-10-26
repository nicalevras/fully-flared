import { z } from 'zod';
import type { ProductStatus } from '../db/schema';

export const productModeSchema = z.enum(['title', 'sku-exact', 'sku-prefix']);
export type ProductMode = z.infer<typeof productModeSchema>;
const cursorSchema = z.object({
  v: z.literal(1),
  direction: z.enum(['next', 'previous']),
  q: z.string(),
  mode: productModeSchema.nullable(),
  createdAt: z.string(),
  id: z.string(),
});
export const productDiscoveryInputSchema = z.object({
  q: z.string().max(200).default(''),
  mode: productModeSchema.nullable().default(null),
  cursor: z.string().max(2000).optional(),
});
export type ProductDiscoveryInput = z.infer<typeof productDiscoveryInputSchema>;
type Position = Pick<z.infer<typeof cursorSchema>, 'createdAt' | 'id' | 'direction'>;
type Candidate = { id: string; created_at: string };
export type AdminProductRow = {
  id: string;
  slug: string;
  title: string;
  status: ProductStatus;
  created_at: string;
  price_cents: number | null;
  available: number;
  image_key: string | null;
};
type DiscoveryResult = {
  products: AdminProductRow[];
  nextCursor: string | null;
  previousCursor: string | null;
  state: 'ready' | 'refine';
};

function decodeCursor(
  cursor: string | undefined,
  q: string,
  mode: ProductMode | null
): Position | null {
  if (!cursor) return null;
  try {
    const bytes = Uint8Array.from(atob(cursor), (character) => character.charCodeAt(0));
    const value = cursorSchema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    );
    if (!value.success || value.data.q !== q || value.data.mode !== mode) return null;
    return { createdAt: value.data.createdAt, id: value.data.id, direction: value.data.direction };
  } catch {
    return null;
  }
}

export function normalizeProductSearch(value: unknown): ProductDiscoveryInput {
  const raw = z
    .object({
      q: z.unknown().optional(),
      mode: z.unknown().optional(),
      cursor: z.unknown().optional(),
    })
    .safeParse(value);
  if (!raw.success) return { q: '', mode: null };
  const q = typeof raw.data.q === 'string' && raw.data.q.length <= 200 ? raw.data.q.trim() : '';
  const mode = q ? productModeSchema.catch('title').parse(raw.data.mode) : null;
  const cursor =
    typeof raw.data.cursor === 'string' &&
    raw.data.cursor.length <= 2000 &&
    decodeCursor(raw.data.cursor, q, mode)
      ? raw.data.cursor
      : undefined;
  return { q, mode, cursor };
}

function encodeCursor(
  input: ProductDiscoveryInput,
  row: Candidate,
  direction: Position['direction']
): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      q: input.q,
      mode: input.mode,
      direction,
      createdAt: row.created_at,
      id: row.id,
    })
  );
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

function after(row: Candidate, cursor: Pick<Position, 'createdAt' | 'id'>): boolean {
  return (
    binaryCompare(row.created_at, cursor.createdAt) < 0 ||
    (row.created_at === cursor.createdAt && binaryCompare(row.id, cursor.id) < 0)
  );
}

function binaryCompare(a: string, b: string): number {
  const left = Array.from(a, (character) => character.codePointAt(0) ?? 0);
  const right = Array.from(b, (character) => character.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  }
  return left.length - right.length;
}

const newest = (a: Candidate, b: Candidate) =>
  binaryCompare(b.created_at, a.created_at) || binaryCompare(b.id, a.id);

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
  if (input.mode === 'title') {
    return (
      await db
        .prepare(
          `SELECT p.id,p.created_at FROM products_fts f
      JOIN products p ON p.rowid=f.rowid WHERE products_fts MATCH ? LIMIT 1001`
        )
        .bind(titleMatch(input.q))
        .all<Candidate>()
    ).results;
  }
  if (input.mode === 'sku-exact') {
    return (
      await db
        .prepare(
          `SELECT p.id,p.created_at FROM variants v
      JOIN products p ON p.id=v.product_id WHERE v.sku=? LIMIT 1001`
        )
        .bind(input.q)
        .all<Candidate>()
    ).results;
  }
  const ceiling = prefixCeiling(input.q);
  const query = `SELECT p.id,p.created_at FROM variants v JOIN products p ON p.id=v.product_id
    WHERE v.sku>=? ${ceiling ? 'AND v.sku<?' : ''} LIMIT 1001`;
  const statement = db.prepare(query);
  return (
    await (ceiling ? statement.bind(input.q, ceiling) : statement.bind(input.q)).all<Candidate>()
  ).results;
}

async function project(db: D1Database, candidates: Candidate[]): Promise<AdminProductRow[]> {
  if (candidates.length === 0) return [];
  const placeholders = candidates.map(() => '?').join(',');
  const result = await db
    .prepare(
      `SELECT p.id,p.slug,p.title,p.status,p.created_at,
    (SELECT MIN(v.price_cents) FROM variants v WHERE v.product_id=p.id AND v.status='active') AS price_cents,
    (SELECT COALESCE(SUM(COALESCE(s.on_hand,0)-COALESCE(s.reserved,0)),0) FROM variants v
      LEFT JOIN stock s ON s.sku=v.sku WHERE v.product_id=p.id AND v.status='active') AS available,
    (SELECT m.r2_key FROM product_media pm JOIN media m ON m.id=pm.media_id
      WHERE pm.product_id=p.id AND m.ready=1 AND m.deletion_pending=0
      ORDER BY pm.position LIMIT 1) AS image_key
    FROM products p WHERE p.id IN (${placeholders})`
    )
    .bind(...candidates.map((row) => row.id))
    .all<AdminProductRow>();
  const byId = new Map(result.results.map((row) => [row.id, row]));
  return candidates.flatMap((row) => {
    const found = byId.get(row.id);
    return found ? [found] : [];
  });
}

export async function adminProductDiscovery(
  db: D1Database,
  raw: unknown
): Promise<DiscoveryResult> {
  const input = productDiscoveryInputSchema.parse(normalizeProductSearch(raw));
  const cursor = decodeCursor(input.cursor, input.q, input.mode);
  let candidates: Candidate[];
  if (input.mode === null) {
    const previous = cursor?.direction === 'previous';
    const query = `SELECT id,created_at FROM products ${cursor ? `WHERE (created_at,id) ${previous ? '>' : '<'} (?,?)` : ''}
      ORDER BY created_at ${previous ? 'ASC' : 'DESC'},id ${previous ? 'ASC' : 'DESC'} LIMIT 51`;
    const statement = db.prepare(query);
    candidates = (
      await (cursor ? statement.bind(cursor.createdAt, cursor.id) : statement).all<Candidate>()
    ).results;
    if (previous) {
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
    candidates = [...new Map(candidates.map((row) => [row.id, row])).values()]
      .sort(newest)
      .filter(
        (row) =>
          !cursor ||
          (cursor.direction === 'previous'
            ? after(
                { id: cursor.id, created_at: cursor.createdAt },
                { id: row.id, createdAt: row.created_at }
              )
            : after(row, cursor))
      );
    if (cursor?.direction === 'previous') {
      const hasEarlier = candidates.length > 50;
      const selected = candidates.slice(-50);
      const last = selected.at(-1);
      return {
        products: await project(db, selected),
        nextCursor: last ? encodeCursor(input, last, 'next') : null,
        previousCursor:
          hasEarlier && selected[0] ? encodeCursor(input, selected[0], 'previous') : null,
        state: 'ready',
      };
    }
  }
  const selected = candidates.slice(0, 50);
  const products = await project(db, selected);
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

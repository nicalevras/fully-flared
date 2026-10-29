import { type PublishedProductCard } from './catalog';
import {
  readListingPage,
  readListingRef,
  readCollectionMeta,
  type CatalogKv,
} from './catalog-read';
import { RAIL_SIZE } from './catalog-models';

// Discovery readers over the partitioned catalog (Phase 3B). Search
// matches through the D1 products_fts index and fetches only matching
// cards — it never walks listing chunks. Collection pages come from
// the published listing generations (KV or exact D1 payload).

type CatalogEnv = { CATALOG_KV?: CatalogKv };

export const SEARCH_PAGE_SIZE = 50;

export type SearchCursor = { createdAt: string; id: string };

export function encodeSearchCursor(cursor: SearchCursor): string {
  return btoa(JSON.stringify({ c: cursor.createdAt, i: cursor.id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function decodeSearchCursor(raw: string | undefined): SearchCursor | null {
  if (!raw || raw.length > 500) return null;
  try {
    const parsed = JSON.parse(atob(raw.replaceAll('-', '+').replaceAll('_', '/'))) as {
      c?: unknown;
      i?: unknown;
    };
    if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string') return null;
    return { createdAt: parsed.c, id: parsed.i };
  } catch {
    return null;
  }
}

/** One bounded page of FTS matches. Continuation is a keyset cursor
 *  over the stable (created_at DESC, id DESC) order: pass the previous
 *  page's nextCursor to fetch the next page. A malformed cursor is
 *  treated as "from the start" rather than an error. `limited` is asked
 *  only when there are terms to match, before any D1 work. */
export async function searchCatalog(
  db: D1Database,
  _env: CatalogEnv,
  query: string,
  cursorRaw?: string,
  limited?: () => Promise<boolean>
): Promise<{ cards: PublishedProductCard[]; nextCursor: string | null; limited?: true }> {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return { cards: [], nextCursor: null };
  if (await limited?.()) return { cards: [], nextCursor: null, limited: true };
  // FTS5 MATCH with quoted terms (user input cannot inject operators).
  const match = terms
    .map((t) => {
      const quoted = `"${t.replace(/"/g, '""')}"`;
      return [...t].length >= 3 ? `${quoted}*` : quoted;
    })
    .join(' ');
  const cursor = decodeSearchCursor(cursorRaw);
  // One extra row detects whether another page exists.
  const hits = await db
    .prepare(
      `SELECT p.id, p.created_at AS createdAt FROM products_fts f JOIN products p ON p.rowid = f.rowid
       WHERE products_fts MATCH ? AND p.status = 'active'
         ${cursor ? 'AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))' : ''}
       ORDER BY p.created_at DESC, p.id DESC LIMIT ${SEARCH_PAGE_SIZE + 1}`
    )
    .bind(...(cursor ? [match, cursor.createdAt, cursor.createdAt, cursor.id] : [match]))
    .all<{ id: string; createdAt: string }>();
  if (!hits.results.length) return { cards: [], nextCursor: null };
  const pageHits = hits.results.slice(0, SEARCH_PAGE_SIZE);
  const last = pageHits[pageHits.length - 1];
  const nextCursor =
    hits.results.length > SEARCH_PAGE_SIZE && last
      ? encodeSearchCursor({ createdAt: last.createdAt, id: last.id })
      : null;
  const ids = pageHits.map((h) => h.id);
  const placeholders = ids.map(() => '?').join(',');
  const cards = await db
    .prepare(`SELECT card_json FROM catalog_cards WHERE product_id IN (${placeholders})`)
    .bind(...ids)
    .all<{ card_json: string }>();
  const byId = new Map(
    cards.results.map((r) => {
      const card = JSON.parse(r.card_json) as PublishedProductCard;
      return [card.id, card];
    })
  );
  return {
    cards: ids.map((id) => byId.get(id)).filter((c): c is PublishedProductCard => Boolean(c)),
    nextCursor,
  };
}

export async function getPublishedCollection(
  db: D1Database,
  env: CatalogEnv,
  slug: string,
  page = 1
) {
  const current = await readCollectionMeta(db, env.CATALOG_KV, slug);
  if (!current) return null;
  const ref = await readListingRef(db, env.CATALOG_KV, current.id);
  if (!ref) return null;
  if (!ref.metadataKey) throw new Error('Published collection metadata is unavailable');
  const collection = await readCollectionMeta(db, env.CATALOG_KV, slug, ref.metadataKey);
  if (!collection || collection.id !== ref.listingId)
    throw new Error('Published collection metadata is unavailable');
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), ref.pageCount);
  const data = await readListingPage(db, env.CATALOG_KV, ref.listingId, clamped, ref);
  if (!data) throw new Error('Published collection page is unavailable');
  return {
    collection,
    products: data.cards,
    total: ref.total,
    page: clamped,
    pageCount: ref.pageCount,
  };
}

/** Home rails: the first RAIL_SIZE cards of each featured collection's
 *  first page, in layout order. A collection that is unpublished or has
 *  no products yet is skipped. */
export async function getFeaturedRails(
  db: D1Database,
  env: CatalogEnv,
  featured: ReadonlyArray<{ slug: string }>
) {
  const rails = await Promise.all(
    featured.map(async ({ slug }) => {
      const published = await getPublishedCollection(db, env, slug);
      return published?.products.length
        ? {
            slug,
            title: published.collection.title,
            products: published.products.slice(0, RAIL_SIZE),
          }
        : null;
    })
  );
  return rails.filter((rail) => rail !== null);
}

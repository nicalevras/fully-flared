import { type PublishedProductCard } from './catalog';
import {
  readListingPage,
  readListingRef,
  readCollectionMeta,
  type CatalogKv,
} from './catalog-read';
import { ALL_LISTING, RAIL_SIZE } from './catalog-models';

// Discovery readers over the partitioned catalog (Phase 3B). Search
// matches through the D1 products_fts index and fetches only matching
// cards — it never walks listing chunks. Collection pages come from
// the published listing generations (KV or exact D1 payload).

type CatalogEnv = { CATALOG_KV?: CatalogKv };

export const SUGGEST_SIZE = 8;

// FTS5 MATCH with quoted terms (user input cannot inject operators).
// Null when the query carries no terms.
function buildMatch(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return null;
  return terms
    .map((t) => {
      const quoted = `"${t.replace(/"/g, '""')}"`;
      return [...t].length >= 3 ? `${quoted}*` : quoted;
    })
    .join(' ');
}

async function fetchCards(db: D1Database, ids: string[]): Promise<PublishedProductCard[]> {
  if (!ids.length) return [];
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
  return ids.map((id) => byId.get(id)).filter((c): c is PublishedProductCard => Boolean(c));
}

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

/** One bounded page of FTS matches for the full results page.
 *  Continuation is a keyset cursor over the stable (created_at DESC,
 *  id DESC) order. A malformed cursor is treated as "from the start"
 *  rather than an error. `limited` is asked only when there are terms
 *  to match, before any D1 work. */
export async function searchCatalog(
  db: D1Database,
  _env: CatalogEnv,
  query: string,
  cursorRaw?: string,
  limited?: () => Promise<boolean>
): Promise<{ cards: PublishedProductCard[]; nextCursor: string | null; limited?: true }> {
  const match = buildMatch(query);
  if (!match) return { cards: [], nextCursor: null };
  if (await limited?.()) return { cards: [], nextCursor: null, limited: true };
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
  return {
    cards: await fetchCards(
      db,
      pageHits.map((h) => h.id)
    ),
    nextCursor,
  };
}

/** Palette search: at most SUGGEST_SIZE cards, no cursor. One extra hit
 *  detects whether more matches exist beyond the palette. */
export async function suggestCatalog(
  db: D1Database,
  _env: CatalogEnv,
  query: string,
  limited?: () => Promise<boolean>
): Promise<{ cards: PublishedProductCard[]; hasMore: boolean; limited?: true }> {
  if (query.trim().length < 3) return { cards: [], hasMore: false };
  const match = buildMatch(query);
  if (!match) return { cards: [], hasMore: false };
  if (await limited?.()) return { cards: [], hasMore: false, limited: true };
  const hits = await db
    .prepare(
      `SELECT p.id FROM products_fts f JOIN products p ON p.rowid = f.rowid
       WHERE products_fts MATCH ? AND p.status = 'active'
       ORDER BY p.created_at DESC, p.id DESC LIMIT ${SUGGEST_SIZE + 1}`
    )
    .bind(match)
    .all<{ id: string }>();
  const pageHits = hits.results.slice(0, SUGGEST_SIZE);
  return {
    cards: await fetchCards(
      db,
      pageHits.map((h) => h.id)
    ),
    hasMore: hits.results.length > SUGGEST_SIZE,
  };
}

export const PALETTE_SUGGESTION_SIZE = 10;

/** Open-state palette suggestions. The head of the published all-products
 *  listing, which the publisher maintains newest first. One listing read,
 *  no product table work, empty when nothing is published. */
export async function getPaletteSuggestions(
  db: D1Database,
  env: CatalogEnv
): Promise<PublishedProductCard[]> {
  const page = await readListingPage(db, env.CATALOG_KV, ALL_LISTING, 1);
  return page ? page.cards.slice(0, PALETTE_SUGGESTION_SIZE) : [];
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

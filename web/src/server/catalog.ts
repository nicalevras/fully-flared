import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  media as mediaT,
  productMedia as productMediaT,
  products as productsT,
  stock as stockT,
  variants as variantsT,
  type ProductStatus,
} from '../db/schema';

export type ProductCard = {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: ProductStatus;
  seoTitle: string | null;
  seoDescription: string | null;
  priceCents: number | null;
  available: number | null;
  imageKey: string | null;
};

function cardQuery(db: D1Database, inventory = true) {
  const d = getDb(db);
  return d
    .select({
      id: productsT.id,
      slug: productsT.slug,
      title: productsT.title,
      description: productsT.description,
      status: productsT.status,
      seoTitle: productsT.seoTitle,
      seoDescription: productsT.seoDescription,
      priceCents: sql<number | null>`MIN(${variantsT.priceCents})`,
      ...(inventory
        ? { available: sql<number>`COALESCE(SUM(${stockT.onHand} - ${stockT.reserved}), 0)` }
        : {}),
      imageKey: sql<
        string | null
      >`(SELECT ${mediaT.r2Key} FROM ${productMediaT} JOIN ${mediaT} ON ${mediaT.id} = ${productMediaT.mediaId} WHERE ${productMediaT.productId} = ${productsT.id} ORDER BY ${productMediaT.position} LIMIT 1)`,
    })
    .from(productsT)
    .leftJoin(variantsT, and(eq(variantsT.productId, productsT.id), eq(variantsT.status, 'active')))
    .$dynamic();
}

export type PublishedProductCard = Omit<ProductCard, 'available'>;

function cards(db: D1Database, inventory: boolean) {
  const query = cardQuery(db, inventory);
  return inventory ? query.leftJoin(stockT, eq(stockT.sku, variantsT.sku)) : query;
}

async function queryProducts(
  db: D1Database,
  opts: {
    status?: ProductStatus;
    search?: string;
    limit?: number;
    unbounded?: boolean;
    offset?: number;
  } = {},
  inventory = true
) {
  const conditions = [];
  if (opts.status) conditions.push(eq(productsT.status, opts.status));
  if (opts.search) {
    // FTS5 full-text index (migration 0003) stays a sql fragment: it is a
    // virtual table Drizzle cannot model. Terms are quoted so user input
    // can never become FTS query syntax.
    const match = opts.search
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '')}"`)
      .join(' ');
    if (match) {
      conditions.push(
        sql`"products"."rowid" IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ${match})`
      );
    }
  }
  const limit = opts.unbounded ? 100_000 : Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const query = cards(db, inventory)
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(productsT.id)
    .orderBy(desc(productsT.createdAt), desc(productsT.id))
    .limit(limit);
  // Only admin pagination changes ordering; published catalog queries keep their format.
  return opts.offset === undefined
    ? query
    : query.orderBy(desc(productsT.createdAt), desc(productsT.id)).offset(opts.offset);
}

export async function listProducts(
  db: D1Database,
  opts: Parameters<typeof queryProducts>[1] = {}
): Promise<ProductCard[]> {
  const rows = await queryProducts(db, opts);
  return rows.map((row) => ({ ...row, available: row.available ?? 0 }));
}

export type CollectionRule =
  | { type: 'title_contains'; value: string }
  | { type: 'price_lte'; value: number }
  | { type: 'price_gte'; value: number };

export function parseRule(ruleJson: string | null): CollectionRule | null {
  if (!ruleJson) return null;
  try {
    const r = JSON.parse(ruleJson) as CollectionRule;
    if (r.type === 'title_contains' && typeof r.value === 'string') return r;
    if ((r.type === 'price_lte' || r.type === 'price_gte') && typeof r.value === 'number') return r;
    return null;
  } catch {
    return null;
  }
}

/** Cards for an explicit ID set, chunked under the D1 bind limit.
 *  Used by checkpointed publication so one invocation never scans
 *  the whole catalog to publish a slice of it. */
export async function listPublishedProductsByIds(
  db: D1Database,
  ids: string[]
): Promise<PublishedProductCard[]> {
  const out: PublishedProductCard[] = [];
  for (let i = 0; i < ids.length; i += 89) {
    const chunk = ids.slice(i, i + 89);
    const rows = await cards(db, false)
      .where(inArray(productsT.id, chunk))
      .groupBy(productsT.id)
      .orderBy(desc(productsT.createdAt), desc(productsT.id));
    out.push(...rows.map(({ available: _ignored, ...card }) => card as PublishedProductCard));
  }
  return out;
}

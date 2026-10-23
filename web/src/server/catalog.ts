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
  imagePublicUrl?: string | null | undefined;
  imageVariants?: Array<{ width: number; url: string }> | undefined;
};

function cardQuery(db: D1Database, inventory = true) {
  const d = getDb(db);
  return d
    .select({
      id: productsT.id,
      slug: productsT.slug,
      title: productsT.title,
      status: productsT.status,
      ...(inventory
        ? {
            description: productsT.description,
            seoTitle: productsT.seoTitle,
            seoDescription: productsT.seoDescription,
          }
        : {}),
      priceCents: sql<number | null>`MIN(${variantsT.priceCents})`,
      ...(inventory
        ? { available: sql<number>`COALESCE(SUM(${stockT.onHand} - ${stockT.reserved}), 0)` }
        : {}),
      imageKey: sql<
        string | null
      >`(SELECT ${mediaT.r2Key} FROM ${productMediaT} JOIN ${mediaT} ON ${mediaT.id} = ${productMediaT.mediaId} WHERE ${productMediaT.productId} = ${productsT.id} AND ${mediaT.ready}=1 AND ${mediaT.deletionPending}=0 ORDER BY ${productMediaT.position} LIMIT 1)`,
      imagePublicUrl: sql<
        string | null
      >`(SELECT m.public_url FROM product_media pm JOIN media m ON m.id=pm.media_id WHERE pm.product_id=${productsT.id} AND m.ready=1 AND m.deletion_pending=0 ORDER BY pm.position LIMIT 1)`,
      imageVariantsJson: sql<
        string | null
      >`(SELECT json_group_array(json_object('width',v.width,'url',COALESCE(v.public_url,'/media/'||m.r2_key||'?w='||v.width))) FROM media_variants v JOIN media m ON m.id=v.media_id WHERE v.ready=1 AND m.ready=1 AND m.deletion_pending=0 AND m.id=(SELECT media_id FROM product_media WHERE product_id=${productsT.id} ORDER BY position LIMIT 1) ORDER BY v.width)`,
    })
    .from(productsT)
    .leftJoin(variantsT, and(eq(variantsT.productId, productsT.id), eq(variantsT.status, 'active')))
    .$dynamic();
}

export type PublishedProductCard = Omit<
  ProductCard,
  'available' | 'description' | 'seoTitle' | 'seoDescription'
>;

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
  return rows.map(({ imageVariantsJson, ...row }) => ({
    ...row,
    description: row.description ?? '',
    seoTitle: row.seoTitle ?? null,
    seoDescription: row.seoDescription ?? null,
    imageVariants: JSON.parse(imageVariantsJson ?? '[]'),
    available: row.available ?? 0,
  }));
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
    out.push(
      ...rows.map(
        ({ available: _ignored, imageVariantsJson, ...card }) =>
          ({
            ...card,
            imageVariants: JSON.parse(imageVariantsJson ?? '[]'),
          }) as PublishedProductCard
      )
    );
  }
  return out;
}

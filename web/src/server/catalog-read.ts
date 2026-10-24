import { z } from 'zod';
import {
  ALL_LISTING,
  HOME_PAGE_SIZE,
  COLLECTION_INDEX,
  POSTS_INDEX,
  LAYOUT_REF_KEY,
  layoutKey,
  layoutModelSchema,
  listingRefKey,
  listingReferenceSchema,
  directoryKey,
  directoryNodeSchema,
  listingPageKey,
  listingArtifactSchema,
  productSlugKey,
  productDocKey,
  productDocumentSchema,
  collectionMetaKey,
  collectionMetaSchema,
  editorialKey,
  editorialDocumentSchema,
  documentPointerSchema,
  movedPointerSchema,
  type MovedPointer,
  immutableDocumentKey,
  indexArtifactSchema,
  postSummarySchema,
  contentRevision,
  type DirectoryNode,
  type ListingReference,
  type ListingPage,
  type ProductDocument,
} from './catalog-models';
import { requestRead } from './exec-context';
import { parseLimits, publishedLimits } from '../schemas/limits';
import type { StoreLimits } from '../lib/settings-definitions';
import { pageWindow } from '../lib/catalog-page';
import type { PublishedProductCard } from './catalog';

export type CatalogKv = {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
};
/** Content-addressed values never change, so their edge copy may live a day. */
export const IMMUTABLE_KV_CACHE_TTL = 86_400;
type EnvLike = { CATALOG_KV?: CatalogKv };
type Json = Record<string, unknown>;

async function kvValue(
  kv: CatalogKv | undefined,
  key: string,
  immutable: boolean
): Promise<string | null> {
  if (!kv) return null;
  return requestRead(kv, `kv:${key}`, async () => {
    try {
      return await (immutable ? kv.get(key, { cacheTtl: IMMUTABLE_KV_CACHE_TTL }) : kv.get(key));
    } catch {
      console.warn(JSON.stringify({ event: 'catalog_kv_read_failed' }));
      return null;
    }
  });
}
function decode<T>(
  raw: string | null,
  schema: z.ZodType<T>,
  valid: (value: T, body: Json) => boolean
): T | null {
  if (!raw) return null;
  try {
    const body: unknown = JSON.parse(raw),
      parsed = schema.safeParse(body);
    if (parsed.success && valid(parsed.data, body as Json)) return parsed.data;
  } catch {
    /* Invalid public cache values use the exact durable mirror. */
  }
  console.warn(
    JSON.stringify({ event: 'catalog_model_kv_read_failed', reason: 'invalid_artifact' })
  );
  return null;
}
async function documentRaw(db: D1Database, key: string): Promise<string | null> {
  return requestRead(db, `mirror:${key}`, async () => {
    const row = await db
      .prepare('SELECT payload_json FROM catalog_documents WHERE key=?')
      .bind(key)
      .first<{ payload_json: string }>();
    return row?.payload_json ?? null;
  });
}
function bodyRevision(body: Json): string {
  const copy = { ...body };
  delete copy.revision;
  return contentRevision(JSON.stringify(copy));
}

export async function loadDirectoryNode(
  db: D1Database,
  kv: CatalogKv | undefined,
  hash: string
): Promise<DirectoryNode | null> {
  return requestRead(kv ?? db, `directory:${hash}`, async () => {
    const valid = (node: DirectoryNode, body: Json) =>
      contentRevision(JSON.stringify(body)) === hash &&
      (node.kind === 'pages'
        ? node.entries.every((e, i) => i === 0 || node.entries[i - 1]!.page < e.page)
        : node.entries.every(
            (e, i) => e.from <= e.to && (i === 0 || node.entries[i - 1]!.to < e.from)
          ));
    const cached = decode(await kvValue(kv, directoryKey(hash), true), directoryNodeSchema, valid);
    if (cached) return cached;
    const row = await db
      .prepare('SELECT payload_json FROM catalog_ref_chunks WHERE hash=?')
      .bind(hash)
      .first<{ payload_json: string }>();
    return decode(row?.payload_json ?? null, directoryNodeSchema, valid);
  });
}
export async function resolveDirectoryRevision(
  db: D1Database,
  kv: CatalogKv | undefined,
  root: string,
  page: number
): Promise<string | null> {
  return requestRead(kv ?? db, `directory-page:${root}:${page}`, async () => {
    let hash = root;
    const seen = new Set<string>();
    for (let depth = 0; depth < 16; depth++) {
      if (seen.has(hash)) return null;
      seen.add(hash);
      const node = await loadDirectoryNode(db, kv, hash);
      if (!node) return null;
      if (node.kind === 'pages') return node.entries.find((e) => e.page === page)?.revision ?? null;
      const child = node.entries.find((e) => page >= e.from && page <= e.to);
      if (!child) return null;
      hash = child.hash;
    }
    return null;
  });
}

export async function readListingRef(
  db: D1Database,
  kv: CatalogKv | undefined,
  listingId: string
): Promise<ListingReference | null> {
  return requestRead(kv ?? db, `listing-ref:${listingId}`, async () => {
    const valid = (ref: ListingReference) =>
      ref.listingId === listingId &&
      ref.pageCount === Math.max(1, Math.ceil(ref.total / ref.pageSize));
    const cached = decode(
      await kvValue(kv, listingRefKey(listingId), false),
      listingReferenceSchema,
      valid
    );
    if (cached) return cached;
    const row = await db
      .prepare(
        `SELECT h.generation,h.publication_seq,h.root_hash,h.page_count,h.total,h.page_size,
      (SELECT rd.document_key FROM catalog_ref_documents rd JOIN catalog_documents d ON d.key=rd.document_key
       WHERE rd.ref_key=? AND rd.publication_seq=h.publication_seq AND d.kind='collection-meta' LIMIT 1) AS metadata_key
      FROM catalog_listing_ref_history h WHERE h.listing_id=? AND h.retired_at IS NULL ORDER BY h.publication_seq DESC LIMIT 1`
      )
      .bind(`listing:${listingId}`, listingId)
      .first<{
        generation: number;
        publication_seq: number;
        root_hash: string;
        page_count: number;
        total: number;
        page_size: number;
        metadata_key: string | null;
      }>();
    if (!row) return null;
    const value = {
      listingId,
      generation: row.generation,
      publicationSeq: row.publication_seq,
      rootHash: row.root_hash,
      pageCount: row.page_count,
      total: row.total,
      pageSize: row.page_size,
      ...(row.metadata_key ? { metadataKey: row.metadata_key } : {}),
    };
    return valid(value) ? value : null;
  });
}

async function pageRaw<T>(
  db: D1Database,
  kv: CatalogKv | undefined,
  ref: ListingReference,
  page: number,
  schema: z.ZodType<T>,
  identity: (value: T) => boolean
): Promise<T | null> {
  if (!Number.isInteger(page) || page < 1 || page > ref.pageCount) return null;
  return requestRead(
    kv ?? db,
    `artifact:${ref.listingId}:${ref.generation}:${ref.rootHash}:${page}`,
    async () => {
      const revision = await resolveDirectoryRevision(db, kv, ref.rootHash, page);
      if (!revision) return null;
      const valid = (value: T, body: Json) =>
        identity(value) && contentRevision(JSON.stringify(body)) === revision;
      const key = listingPageKey(ref.listingId, page, revision);
      const cached = decode(await kvValue(kv, key, true), schema, valid);
      if (cached) return cached;
      const row = await db
        .prepare(
          'SELECT payload_json FROM catalog_listing_page_revisions WHERE listing_id=? AND generation=? AND page=? AND revision=?'
        )
        .bind(ref.listingId, ref.generation, page, revision)
        .first<{ payload_json: string }>();
      return decode(row?.payload_json ?? null, schema, valid);
    }
  );
}

export async function readListingPage(
  db: D1Database,
  kv: CatalogKv | undefined,
  listingId: string,
  page: number,
  pinnedRef?: ListingReference | null
): Promise<ListingPage | null> {
  const ref = pinnedRef === undefined ? await readListingRef(db, kv, listingId) : pinnedRef;
  if (!ref || ref.listingId !== listingId) return null;
  return requestRead(
    kv ?? db,
    `listing-page:${listingId}:${ref.publicationSeq}:${ref.rootHash}:${page}`,
    async () => {
      const artifact = await pageRaw(
        db,
        kv,
        ref,
        page,
        listingArtifactSchema,
        (v) =>
          v.listingId === listingId &&
          v.page === page &&
          v.pageSize === ref.pageSize &&
          v.cards.length ===
            Math.min(ref.pageSize, Math.max(0, ref.total - (page - 1) * ref.pageSize))
      );
      return artifact
        ? { ...artifact, generation: ref.generation, total: ref.total, pageCount: ref.pageCount }
        : null;
    }
  );
}

/** `beforeFallback` runs only when KV has no pointer, before D1 is
 *  asked; it may throw to refuse the lookup. A renamed slug answers
 *  with its moved pointer. */
export async function readProductDocument(
  db: D1Database,
  kv: CatalogKv | undefined,
  slug: string,
  beforeFallback?: () => Promise<void>
): Promise<ProductDocument | MovedPointer | null> {
  return requestRead(kv ?? db, `product:${slug}`, async () => {
    const pointerSchema = z.union([
      z.object({ id: z.string().min(1), revision: z.string().min(1) }).strict(),
      movedPointerSchema,
    ]);
    const current = decode(
      await kvValue(kv, productSlugKey(slug), false),
      pointerSchema,
      () => true
    );
    if (current && 'redirect' in current) return current;
    let pointer = current;
    if (!pointer) {
      await beforeFallback?.();
      const row = await db
        .prepare('SELECT product_id,doc_revision FROM catalog_cards WHERE slug=?')
        .bind(slug)
        .first<{ product_id: string; doc_revision: string }>();
      if (!row?.doc_revision) return null;
      pointer = { id: row.product_id, revision: row.doc_revision };
    }
    const pinned = pointer,
      key = productDocKey(pinned.id, pinned.revision);
    const valid = (doc: ProductDocument, body: Json) =>
      doc.id === pinned.id &&
      doc.slug === slug &&
      doc.revision === pinned.revision &&
      bodyRevision(body) === pinned.revision;
    const doc =
      decode(await kvValue(kv, key, true), productDocumentSchema, valid) ??
      decode(await documentRaw(db, key), productDocumentSchema, valid);
    if (!doc) throw new Error('Published product document is unavailable');
    return doc;
  });
}

async function readDocument<T>(
  db: D1Database,
  kv: CatalogKv | undefined,
  base: string,
  schema: z.ZodType<T>,
  identity: (value: T) => boolean,
  pinnedKey?: string
): Promise<T | MovedPointer | null> {
  const current = pinnedKey
    ? { key: pinnedKey, revision: pinnedKey.slice(pinnedKey.lastIndexOf(':') + 1) }
    : decode(
        await kvValue(kv, base, false),
        z.union([documentPointerSchema, movedPointerSchema]),
        (p) => 'redirect' in p || p.key === immutableDocumentKey(base, p.revision)
      );
  if (current && 'redirect' in current) return current;
  let pointer = current;
  if (!pointer)
    pointer = decode(
      await documentRaw(db, base),
      documentPointerSchema,
      (p) => p.key === immutableDocumentKey(base, p.revision)
    );
  if (!pointer || pointer.key !== immutableDocumentKey(base, pointer.revision)) return null;
  const revision = pointer.revision;
  const valid = (value: T, body: Json) =>
    identity(value) && contentRevision(JSON.stringify(body)) === revision;
  const doc =
    decode(await kvValue(kv, pointer.key, true), schema, valid) ??
    decode(await documentRaw(db, pointer.key), schema, valid);
  if (!doc) throw new Error('Published document is unavailable');
  return doc;
}

export async function readCollectionMeta(
  db: D1Database,
  kv: CatalogKv | undefined,
  slug: string,
  pinnedKey?: string
) {
  const meta = await readDocument(
    db,
    kv,
    collectionMetaKey(slug),
    collectionMetaSchema,
    (v) => v.slug === slug,
    pinnedKey
  );
  return meta && 'redirect' in meta ? null : meta;
}
export async function readEditorialDocument(
  db: D1Database,
  kv: CatalogKv | undefined,
  kind: 'post' | 'page',
  slug: string
) {
  return requestRead(kv ?? db, `editorial:${kind}:${slug}`, () =>
    readDocument(
      db,
      kv,
      editorialKey(kind, slug),
      editorialDocumentSchema,
      (v) => v.kind === kind && v.slug === slug
    )
  );
}

export type StorefrontLayoutSnapshot = {
  limits: StoreLimits;
  storeName: string;
  announcementText: string;
  seoTitleTemplate: string;
  canonicalBaseUrl: string;
  currency: string;
  collections: Array<{ slug: string; title: string }>;
  collectionsTotal: number;
  collectionTeasers: Array<{ slug: string; title: string; description: string }>;
  featured: Array<{ slug: string; title: string }>;
  posts: Array<{ slug: string; title: string; excerpt: string; published_at: string }>;
};
export function getStorefrontLayout(
  db: D1Database,
  env: EnvLike
): Promise<StorefrontLayoutSnapshot> {
  const kv = env.CATALOG_KV;
  return requestRead(kv ?? db, 'layout', async () => {
    const refSchema = z.object({ revision: z.string().min(1) }).strict();
    let ref = decode(await kvValue(kv, LAYOUT_REF_KEY, false), refSchema, () => true);
    if (!ref) {
      const row = await db
        .prepare("SELECT root_hash FROM catalog_ref_state WHERE ref_key='layout'")
        .first<{ root_hash: string | null }>();
      if (row?.root_hash) ref = { revision: row.root_hash };
    }
    if (ref) {
      const key = layoutKey(ref.revision);
      const valid = (value: z.infer<typeof layoutModelSchema>, body: Json) =>
        value.revision === ref!.revision &&
        contentRevision(JSON.stringify({ ...body, revision: '' })) === ref!.revision &&
        Boolean(publishedLimits(value.limits));
      const model =
        decode(await kvValue(kv, key, true), layoutModelSchema, valid) ??
        decode(await documentRaw(db, key), layoutModelSchema, valid);
      if (!model) throw new Error('Published storefront layout is unavailable');
      return { ...model, limits: publishedLimits(model.limits) };
    }
    return {
      limits: parseLimits({}),
      storeName: 'My Store',
      announcementText: '',
      seoTitleTemplate: '{product} · {store_name}',
      canonicalBaseUrl: '',
      currency: 'USD',
      collections: [],
      collectionsTotal: 0,
      collectionTeasers: [],
      featured: [],
      posts: [],
    };
  });
}

export type ShopProductsPage = {
  products: PublishedProductCard[];
  total: number;
  page: number;
  pageCount: number;
};
export async function getShopProductsPage(
  db: D1Database,
  env: EnvLike,
  requestedPage: number
): Promise<ShopProductsPage> {
  const ref = await readListingRef(db, env.CATALOG_KV, ALL_LISTING);
  if (!ref) return { products: [], total: 0, page: 1, pageCount: 1 };
  const { page } = pageWindow(ref.total, requestedPage, HOME_PAGE_SIZE);
  const listing = await readListingPage(db, env.CATALOG_KV, ALL_LISTING, page, ref);
  if (!listing) throw new Error('Published catalog page is unavailable');
  return { products: listing.cards, total: ref.total, page, pageCount: ref.pageCount };
}
export async function getHomeCollections(db: D1Database, env: EnvLike) {
  return (await getStorefrontLayout(db, env)).collectionTeasers;
}

async function readIndex(
  db: D1Database,
  env: EnvLike,
  listingId: typeof COLLECTION_INDEX | typeof POSTS_INDEX,
  page: number
) {
  const ref = await readListingRef(db, env.CATALOG_KV, listingId);
  if (!ref) return { items: [], total: 0, page: 1, pageCount: 1 };
  const clamped = pageWindow(ref.total, page, ref.pageSize).page;
  const artifact = await pageRaw(
    db,
    env.CATALOG_KV,
    ref,
    clamped,
    indexArtifactSchema,
    (v) =>
      v.listingId === listingId &&
      v.page === clamped &&
      v.pageSize === ref.pageSize &&
      v.items.length ===
        Math.min(ref.pageSize, Math.max(0, ref.total - (clamped - 1) * ref.pageSize))
  );
  if (!artifact) throw new Error('Published catalog index is unavailable');
  return { items: artifact.items, total: ref.total, page: clamped, pageCount: ref.pageCount };
}
export const COLLECTIONS_PAGE_SIZE = 48;
export async function listAllCollections(db: D1Database, env: EnvLike, page = 1) {
  const result = await readIndex(db, env, COLLECTION_INDEX, page);
  return {
    collections: result.items.map((item) => collectionMetaSchema.parse(item)),
    total: result.total,
    page: result.page,
    pageCount: result.pageCount,
  };
}
export async function listPublishedPosts(db: D1Database, env: EnvLike, page = 1) {
  const result = await readIndex(db, env, POSTS_INDEX, page);
  return {
    posts: result.items.map((item) => postSummarySchema.parse(item)),
    total: result.total,
    page: result.page,
    pageCount: result.pageCount,
  };
}

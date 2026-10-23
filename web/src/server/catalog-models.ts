import { z } from 'zod';

// Partitioned catalog read models (Phase 3). Zod-validated contracts
// shared by the publisher (write side) and, from 3B, storefront readers.
// Every value is validated at the boundary; an invalid or missing KV
// value falls back to the D1 page payloads, never to a blank page.

export const ALL_LISTING = 'all';
export const HOME_PAGE_SIZE = 24;
export const COLLECTION_PAGE_SIZE = 48;

export const catalogCardSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  status: z.enum(['active', 'archived', 'draft']),
  priceCents: z.number().nullable(),
  imageKey: z.string().nullable(),
  imagePublicUrl: z.string().nullable().optional(),
  imageVariants: z.array(z.object({ width: z.number(), url: z.string() })).optional(),
});
export type CatalogCard = z.infer<typeof catalogCardSchema>;

/** Product document: one product with active variants, media and SEO.
 *  Deliberately carries no inventory counters — availability is read
 *  separately after hydration, once per page load. */
export const productDocumentSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['active', 'archived', 'draft']),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  variants: z.array(
    z.object({
      id: z.string(),
      sku: z.string(),
      title: z.string(),
      priceCents: z.number(),
      compareAtCents: z.number().nullable(),
      status: z.string(),
      continueSelling: z.boolean(),
      weightGrams: z.number().nullable(),
    })
  ),
  images: z.array(
    z.object({
      key: z.string(),
      alt: z.string(),
      publicUrl: z.string().nullable().optional(),
      variants: z.array(z.object({ width: z.number(), url: z.string() })).optional(),
    })
  ),
  revision: z.string(),
});
export type ProductDocument = z.infer<typeof productDocumentSchema>;

export const listingPageSchema = z.object({
  listingId: z.string(),
  generation: z.number().int(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
  pageCount: z.number().int().min(1),
  cards: z.array(catalogCardSchema),
});
export type ListingPage = z.infer<typeof listingPageSchema>;
// Publication metadata belongs to the reference, not an immutable page.
export const listingArtifactSchema = listingPageSchema
  .omit({ generation: true, total: true, pageCount: true })
  .strict();
export function serializeListingPage(page: ListingPage): string {
  const value = JSON.stringify({
    listingId: page.listingId,
    page: page.page,
    pageSize: page.pageSize,
    cards: page.cards,
  });
  if (new TextEncoder().encode(value).byteLength > 1_500_000)
    throw new Error('Catalog page exceeds artifact byte budget');
  return value;
}
export function listingPageRevision(page: ListingPage): string {
  return contentRevision(serializeListingPage(page));
}

// Mutable per-listing reference. It stays small at any catalog size:
// the immutable directory root hash identifies the exact page
// revisions, so no growing pageRevisions array is ever stored here.
export const listingReferenceSchema = z.object({
  listingId: z.string(),
  generation: z.number().int(),
  publicationSeq: z.number().int().min(0),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
  pageCount: z.number().int().min(1),
  rootHash: z.string(),
  metadataKey: z.string().optional(),
});
export type ListingReference = z.infer<typeof listingReferenceSchema>;

// Immutable directory tree nodes (fixed fan-out: at most 128 entries
// per node, extra levels as the catalog grows). Leaf nodes name exact
// page revisions; index nodes name child nodes by page range. Nodes
// are content-addressed, stored in both KV and D1
// (catalog_ref_chunks), and resolve the exact revision the pinned
// root identifies — including A -> B -> A content reuse.
export const DIRECTORY_FANOUT = 128;
export const directoryLeafSchema = z.object({
  kind: z.literal('pages'),
  entries: z
    .array(z.object({ page: z.number().int().min(1), revision: z.string() }))
    .min(1)
    .max(DIRECTORY_FANOUT),
});
export const directoryIndexSchema = z.object({
  kind: z.literal('index'),
  entries: z
    .array(
      z.object({
        from: z.number().int().min(1),
        to: z.number().int().min(1),
        hash: z.string(),
      })
    )
    .min(1)
    .max(DIRECTORY_FANOUT),
});
export const directoryNodeSchema = z.discriminatedUnion('kind', [
  directoryLeafSchema,
  directoryIndexSchema,
]);
export type DirectoryNode = z.infer<typeof directoryNodeSchema>;

export const layoutModelSchema = z.object({
  limits: z.record(z.string(), z.number()),
  storeName: z.string(),
  announcementText: z.string(),
  seoTitleTemplate: z.string(),
  canonicalBaseUrl: z.string(),
  currency: z.string(),
  collections: z.array(z.object({ slug: z.string(), title: z.string() })).max(8),
  collectionsTotal: z.number().int().nonnegative(),
  collectionTeasers: z
    .array(z.object({ slug: z.string(), title: z.string(), description: z.string() }))
    .max(4),
  posts: z
    .array(
      z.object({
        slug: z.string(),
        title: z.string(),
        excerpt: z.string(),
        published_at: z.string(),
      })
    )
    .max(3),
  revision: z.string(),
});
export type LayoutModel = z.infer<typeof layoutModelSchema>;

export const editorialDocumentSchema = z.object({
  kind: z.enum(['post', 'page']),
  slug: z.string(),
  title: z.string(),
  excerpt: z.string(),
  contentHtml: z.string(),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  publishedAt: z.string().nullable(),
  coverKey: z.string().nullable(),
  coverPublicUrl: z.string().nullable().optional(),
  tags: z.string().nullable(),
  authorName: z.string().nullable(),
});
export type EditorialDocument = z.infer<typeof editorialDocumentSchema>;

// Versioned KV namespace. Immutable values carry their content revision
// in the key; mutable references stay small so a hot key never holds a
// whole page of cards.
const NS = 'catalog:r1';
export const productDocKey = (id: string, revision: string) => `${NS}:product:${id}:${revision}`;
export const productSlugKey = (slug: string) => `${NS}:slug:product:${slug}`;
export const listingPageKey = (listingId: string, page: number, revision: string) =>
  `${NS}:listing:${listingId}:page:${page}:${revision}`;
export const listingRefKey = (listingId: string) => `${NS}:listing:${listingId}:current`;
export const directoryKey = (hash: string) => `${NS}:dir:${hash}`;
// Per-collection metadata document: fixed size per collection (never
// a growing shared document), keyed by slug for the storefront route.
export const collectionMetaKey = (slug: string) => `${NS}:collection:${slug}:meta`;
export const collectionMetaSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  kind: z.string(),
  ruleJson: z.string().nullable(),
});
export type CollectionMeta = z.infer<typeof collectionMetaSchema>;
export const layoutKey = (revision: string) => `${NS}:layout:${revision}`;
export const LAYOUT_REF_KEY = `${NS}:layout:current`;
export const editorialKey = (kind: 'post' | 'page', slug: string) => `${NS}:doc:${kind}:${slug}`;
export const documentPointerSchema = z.object({ key: z.string(), revision: z.string() }).strict();
export const immutableDocumentKey = (base: string, revision: string) => `${base}:v:${revision}`;
export const COLLECTION_INDEX = '@collections';
export const POSTS_INDEX = '@posts';
export const postSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  excerpt: z.string(),
  published_at: z.string(),
});
export const indexArtifactSchema = z
  .object({
    listingId: z.enum([COLLECTION_INDEX, POSTS_INDEX]),
    page: z.number().int().min(1),
    pageSize: z.number().int().positive(),
    items: z.array(z.union([collectionMetaSchema, postSummarySchema])),
  })
  .strict();

/** Content-addressed revision for change detection (not a security
 *  token): FNV-1a 64-bit over the serialized value, synchronous so a
 *  10k-product build does not pay 20k async crypto round-trips. */
export function contentRevision(json: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < json.length; i++) {
    hash ^= BigInt(json.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

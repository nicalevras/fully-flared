// FTS5 search index: `products_fts` is a virtual table and cannot be a
// Drizzle table; it lives in the custom part of migration 0003 and is
// queried only through FTS MATCH in server/catalog.ts. Everything else in
// the database is modelled below. All timestamps are ISO-8601 UTC text.

import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ---------- Better Auth core (user/session/account/verification) ----------
export const reconciliationCursors = sqliteTable('reconciliation_cursors', {
  name: text('name').primaryKey(),
  cursor: text('cursor').notNull().default(''),
  updatedAt: text('updated_at').notNull(),
});

export const maintenanceRuns = sqliteTable(
  'maintenance_runs',
  {
    id: text('id').primaryKey(),
    task: text('task').notNull(),
    state: text('state').notNull().default('pending'),
    cutoff: text('cutoff').notNull(),
    progressJson: text('progress_json').notNull().default('{}'),
    nextAt: text('next_at').notNull(),
    claimToken: text('claim_token'),
    claimExpiresAt: text('claim_expires_at'),
    startedAt: text('started_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
  },
  (t) => [
    index('maintenance_due_idx').on(t.state, t.nextAt),
    index('maintenance_task_idx').on(t.task, t.state),
    uniqueIndex('maintenance_active_task_unique')
      .on(t.task)
      .where(sql`${t.state} IN ('pending','running')`),
  ]
);

export const user = sqliteTable(
  'user',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    image: text('image'),
    role: text('role').notNull().default('customer'),
    banned: integer('banned', { mode: 'boolean' }).notNull().default(false),
    banReason: text('ban_reason'),
    banExpires: integer('ban_expires', { mode: 'timestamp_ms' }),
    twoFactorEnabled: integer('two_factor_enabled', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('user_created_id_idx').on(t.createdAt, t.id)]
);

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    impersonatedBy: text('impersonated_by'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('session_user_idx').on(t.userId)]
);

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)]
);

export const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
});

export const staffTwoFactorSessions = sqliteTable(
  'staff_two_factor_sessions',
  {
    sessionId: text('session_id')
      .primaryKey()
      .references(() => session.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verifiedAt: text('verified_at').notNull(),
  },
  (t) => [index('staff_two_factor_sessions_user_idx').on(t.userId)]
);

export const twoFactor = sqliteTable('two_factor', {
  id: text('id').primaryKey(),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  verified: integer('verified', { mode: 'boolean' }).default(true),
  failedVerificationCount: integer('failed_verification_count').default(0),
  lockedUntil: integer('locked_until', { mode: 'timestamp_ms' }),
});

// ---------- Store settings (installer data, never code) ----------
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ---------- Catalogue ----------
export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    descriptionHtml: text('description_html'),
    status: text('status', { enum: ['active', 'draft', 'archived'] })
      .notNull()
      .default('draft'),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    canonicalUrl: text('canonical_url'),
    ogImageKey: text('og_image_key'),
    taxCode: text('tax_code'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('products_status_idx').on(t.status),
    index('products_created_id_idx').on(t.createdAt, t.id),
    index('products_title_id_idx').on(sql`${t.title} COLLATE NOCASE`, t.id),
    index('products_updated_id_idx').on(t.updatedAt, t.id),
    index('products_status_created_id_idx').on(t.status, t.createdAt, t.id),
    index('products_status_updated_id_idx').on(t.status, t.updatedAt, t.id),
    index('products_status_title_id_idx').on(t.status, sql`${t.title} COLLATE NOCASE`, t.id),
  ]
);

export const variants = sqliteTable(
  'variants',
  {
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull().unique(),
    title: text('title').notNull(),
    priceCents: integer('price_cents').notNull(),
    compareAtCents: integer('compare_at_cents'),
    costCents: integer('cost_cents'),
    weightGrams: integer('weight_grams'),
    status: text('status', { enum: ['active', 'draft'] })
      .notNull()
      .default('active'),
    continueSelling: integer('continue_selling', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('variants_product_idx').on(t.productId)]
);

export const media = sqliteTable('media', {
  id: text('id').primaryKey(),
  r2Key: text('r2_key').notNull().unique(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  altText: text('alt_text').notNull().default(''),
  deletionPending: integer('deletion_pending', { mode: 'boolean' }).notNull().default(false),
  publicUrl: text('public_url'),
  ready: integer('ready', { mode: 'boolean' }).notNull().default(true),
  uploadClaimToken: text('upload_claim_token'),
  uploadClaimUntil: text('upload_claim_until'),
  createdAt: text('created_at').notNull(),
});

// Destinations are registered before public writes, including incomplete uploads.
// Tombstones survive media deletion so delayed writers cannot revive publication.
export const mediaPublications = sqliteTable(
  'media_publications',
  {
    id: text('id').primaryKey(),
    mediaId: text('media_id').references(() => media.id, { onDelete: 'set null' }),
    objectKey: text('object_key').notNull(),
    publicUrl: text('public_url').notNull().unique(),
    state: text('state', { enum: ['pending', 'ready', 'deleted'] })
      .notNull()
      .default('pending'),
    claimToken: text('claim_token'),
    claimExpiresAt: text('claim_expires_at'),
    fencing: integer('fencing').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('media_publication_media_idx').on(t.mediaId, t.state)]
);

export const mediaVariants = sqliteTable(
  'media_variants',
  {
    mediaId: text('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    width: integer('width').notNull(),
    r2Key: text('r2_key').notNull().unique(),
    publicUrl: text('public_url'),
    contentType: text('content_type').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: text('created_at').notNull(),
    ready: integer('ready', { mode: 'boolean' }).notNull().default(false),
    uploadClaimUntil: text('upload_claim_until'),
    uploadClaimToken: text('upload_claim_token'),
  },
  (t) => [primaryKey({ columns: [t.mediaId, t.width] })]
);

export const productMedia = sqliteTable(
  'product_media',
  {
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    mediaId: text('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    index('product_media_product_idx').on(t.productId),
    index('product_media_media_idx').on(t.mediaId),
  ]
);

export const collections = sqliteTable(
  'collections',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    kind: text('kind', { enum: ['manual', 'rule'] })
      .notNull()
      .default('manual'),
    ruleJson: text('rule_json'),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    featuredRank: integer('featured_rank'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('collections_title_id_idx').on(t.title, t.id)]
);

export const productCollections = sqliteTable(
  'product_collections',
  {
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.productId] }),
    index('product_collections_product_idx').on(t.productId),
  ]
);

// ---------- Catalog read models (Phase 3A, additive) ----------
// Partitioned publication replacing the whole-catalog snapshot in 3B.
// These tables are the publisher's D1 source of truth and the exact
// fallback for KV misses; the live snapshot path does not read them yet.

export const catalogWork = sqliteTable(
  'catalog_work',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    entitySlug: text('entity_slug'),
    targetRevision: integer('target_revision').notNull().default(0),
    processedRevision: integer('processed_revision').notNull().default(0),
    buildToken: text('build_token'),
    checkpoint: text('checkpoint'),
    retryCount: integer('retry_count').notNull().default(0),
    nextAttemptAt: text('next_attempt_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('catalog_work_entity_unique').on(t.entityType, t.entityId),
    index('catalog_work_due_idx').on(t.processedRevision, t.nextAttemptAt),
    index('catalog_work_pending_idx')
      .on(t.nextAttemptAt, t.updatedAt)
      .where(sql`${t.processedRevision}<${t.targetRevision}`),
  ]
);

export const catalogCards = sqliteTable('catalog_cards', {
  productId: text('product_id')
    .primaryKey()
    .references(() => products.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  cardJson: text('card_json').notNull(),
  revision: text('revision').notNull(),
  docRevision: text('doc_revision').notNull().default(''),
  // The card revision whose KV/page writes have been confirmed. D1
  // revision columns only advance after the matching KV writes land
  // (write-then-advance), so a failed put is retried, never skipped.
  publishedRevision: text('published_revision').notNull().default(''),
  updatedAt: text('updated_at').notNull(),
});

export const catalogMembership = sqliteTable(
  'catalog_membership',
  {
    listingId: text('listing_id').notNull(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.listingId, t.productId] }),
    index('catalog_membership_listing_idx').on(t.listingId, t.position),
    index('catalog_membership_product_idx').on(t.productId),
  ]
);

export const catalogListings = sqliteTable(
  'catalog_listings',
  {
    listingId: text('listing_id').notNull(),
    generation: integer('generation').notNull(),
    pageSize: integer('page_size').notNull(),
    pageCount: integer('page_count').notNull(),
    total: integer('total').notNull(),
    active: integer('active').notNull().default(0),
    // building | active | superseded — set by the activation commit.
    state: text('state').notNull().default('active'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.listingId, t.generation] }),
    index('catalog_listings_active_idx').on(t.listingId, t.active),
    index('catalog_listings_cleanup_idx').on(t.active, t.updatedAt, t.listingId, t.generation),
  ]
);

// Immutable page payloads keyed by their content revision. A page is
// never overwritten in place; patches add a new revision row. Retained
// for the 7-day fallback window after supersession.
export const catalogListingPageRevisions = sqliteTable(
  'catalog_listing_page_revisions',
  {
    listingId: text('listing_id').notNull(),
    generation: integer('generation').notNull(),
    page: integer('page').notNull(),
    revision: text('revision').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    // Revision is part of the key: a page can hold several retained
    // revisions (A -> B -> A), and the pinned directory names the
    // exact one to resolve.
    primaryKey({ columns: [t.listingId, t.generation, t.page, t.revision] }),
    index('catalog_listing_page_revisions_revision_idx').on(t.listingId, t.generation, t.revision),
    index('catalog_page_artifact_idx').on(t.listingId, t.page, t.revision, t.generation),
  ]
);

// Checkpointed publication builds (Round 4): one resumable build row
// whose state_json holds only small cursors — never catalog payloads.
export const catalogBuilds = sqliteTable(
  'catalog_builds',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull().default('full'),
    state: text('state').notNull().default('building'),
    phase: text('phase').notNull().default('cards'),
    stateJson: text('state_json').notNull().default('{}'),
    publicationSeq: integer('publication_seq'),
    // Scoped builds (one listing) carry their parent and scope; every
    // build captures the source-work revision it represents so later
    // edits stay due (Round 2 execution model, migration 0010).
    parentId: text('parent_id'),
    scopeListingId: text('scope_listing_id'),
    sourceRevision: integer('source_revision'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('catalog_builds_cleanup_idx').on(t.state, t.updatedAt, t.id)]
);

// Per-listing build progress in rows (never catalog-sized checkpoint
// JSON): the staged generation, its directory root once computed, and
// whether it differs from the committed publication.
export const catalogBuildListings = sqliteTable(
  'catalog_build_listings',
  {
    buildId: text('build_id').notNull(),
    listingId: text('listing_id').notNull(),
    generation: integer('generation'),
    rootHash: text('root_hash'),
    changed: integer('changed'),
    pageCount: integer('page_count'),
    total: integer('total'),
  },
  (t) => [primaryKey({ columns: [t.buildId, t.listingId] })]
);

// Per-page build progress in rows: the exact revision staged for
// each page of a build's listing generation.
export const catalogBuildPages = sqliteTable(
  'catalog_build_pages',
  {
    buildId: text('build_id').notNull(),
    listingId: text('listing_id').notNull(),
    page: integer('page').notNull(),
    revision: text('revision').notNull(),
  },
  (t) => [primaryKey({ columns: [t.buildId, t.listingId, t.page] })]
);

// Immutable D1 mirrors of published documents (product, layout,
// collection metadata, editorial). KV remains the read path; mirrors
// make committed artifacts recoverable without rebuilding from
// current source. Keyed by KV key; revision is the content hash.
export const catalogDocuments = sqliteTable('catalog_documents', {
  key: text('key').primaryKey(),
  kind: text('kind').notNull(),
  revision: text('revision').notNull(),
  payloadJson: text('payload_json').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Which documents each committed reference publication used, keyed
// by reference and publication sequence (historical record).
export const catalogRefDocuments = sqliteTable(
  'catalog_ref_documents',
  {
    refKey: text('ref_key').notNull(),
    publicationSeq: integer('publication_seq').notNull(),
    documentKey: text('document_key').notNull(),
    retiredAt: text('retired_at'),
  },
  (t) => [
    primaryKey({ columns: [t.refKey, t.publicationSeq, t.documentKey] }),
    index('catalog_ref_documents_retired_idx').on(
      t.retiredAt,
      t.refKey,
      t.publicationSeq,
      t.documentKey
    ),
  ]
);

// Singleton monotonic publication identity allocator and the
// publisher lease coordinator: one lease token + fencing generation
// + expiry serializes publishers; commits guard on the held fence.
export const catalogPublicationState = sqliteTable('catalog_publication_state', {
  id: integer('id').primaryKey(),
  publicationSeq: integer('publication_seq').notNull().default(0),
  gcRevision: integer('gc_revision').notNull().default(0),
  leaseToken: text('lease_token'),
  leaseFencing: integer('lease_fencing').notNull().default(0),
  leaseExpiresAt: text('lease_expires_at'),
  workRevision: integer('work_revision').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});

// Per-reference committed/delivered publication positions. Committed
// state in D1 is the authority; KV delivery may lag and is repaired
// from here. lastWriteAt persists per-key write timing for KV's
// per-key write-rate limit.
export const catalogRefState = sqliteTable(
  'catalog_ref_state',
  {
    refKey: text('ref_key').primaryKey(),
    committedSeq: integer('committed_seq').notNull().default(0),
    deliveredSeq: integer('delivered_seq').notNull().default(0),
    rootHash: text('root_hash'),
    lastWriteAt: text('last_write_at'),
    // Exact pending delivery: the serialized reference awaiting KV
    // delivery, when to retry it, and the last failure seen. Delivery
    // confirmation is guarded by committed sequence.
    pendingPayload: text('pending_payload'),
    deliveryRetryAt: text('delivery_retry_at'),
    deliveryFailure: text('delivery_failure'),
    expectedPayload: text('expected_payload'),
    verifyAfter: text('verify_after'),
    verifiedSeq: integer('verified_seq').notNull().default(0),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('catalog_reference_verify_idx').on(t.verifyAfter),
    index('catalog_reference_delivery_idx')
      .on(t.deliveryRetryAt, t.committedSeq)
      .where(sql`${t.pendingPayload} IS NOT NULL OR ${t.committedSeq}>${t.deliveredSeq}`),
  ]
);

// Immutable directory-tree nodes (fixed fan-out, <=128 entries each),
// stored in D1 so an exact fallback never depends on KV alone.
export const catalogRefChunks = sqliteTable('catalog_ref_chunks', {
  hash: text('hash').primaryKey(),
  listingId: text('listing_id').notNull(),
  payloadJson: text('payload_json').notNull(),
  createdAt: text('created_at').notNull(),
});

// Every retained publication's immutable root. Several card-only
// publications can share one generation, so the key includes the
// publication sequence. retiredAt starts the 7-day reclamation window.
export const catalogListingRefHistory = sqliteTable(
  'catalog_listing_ref_history',
  {
    listingId: text('listing_id').notNull(),
    generation: integer('generation').notNull(),
    publicationSeq: integer('publication_seq').notNull(),
    rootHash: text('root_hash').notNull(),
    pageCount: integer('page_count').notNull(),
    total: integer('total').notNull(),
    pageSize: integer('page_size').notNull(),
    retiredAt: text('retired_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.listingId, t.generation, t.publicationSeq] }),
    index('catalog_history_retired_idx').on(
      t.retiredAt,
      t.listingId,
      t.generation,
      t.publicationSeq
    ),
  ]
);

// One lifecycle per immutable KV key, shared across listing generations.
export const catalogArtifacts = sqliteTable(
  'catalog_artifacts',
  {
    key: text('key').primaryKey(),
    kind: text('kind').notNull(),
    listingId: text('listing_id'),
    page: integer('page'),
    revision: text('revision'),
    unreferencedAt: text('unreferenced_at'),
    markEpoch: integer('mark_epoch').notNull().default(0),
    deletionPending: integer('deletion_pending').notNull().default(0),
    retryAt: text('retry_at'),
    failure: text('failure'),
  },
  (t) => [index('catalog_artifacts_retry_idx').on(t.retryAt, t.key)]
);

export const catalogGcMarks = sqliteTable(
  'catalog_gc_marks',
  {
    key: text('key').primaryKey(),
    kind: text('kind').notNull(),
    processed: integer('processed').notNull().default(0),
  },
  (t) => [index('catalog_gc_marks_pending_idx').on(t.processed, t.kind, t.key)]
);

export const catalogGcState = sqliteTable('catalog_gc_state', {
  id: integer('id').primaryKey(),
  phase: text('phase').notNull().default('idle'),
  step: integer('step').notNull().default(0),
  cursor: text('cursor').notNull().default(''),
  epoch: integer('epoch').notNull().default(0),
  sourceRevision: integer('source_revision').notNull().default(0),
  startedAt: text('started_at'),
  nextRunAt: text('next_run_at'),
});

export const catalogPageProducts = sqliteTable(
  'catalog_page_products',
  {
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    listingId: text('listing_id').notNull(),
    generation: integer('generation').notNull(),
    page: integer('page').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.listingId, t.generation, t.page] }),
    index('catalog_page_products_product_idx').on(t.productId, t.listingId),
    index('catalog_page_products_generation_idx').on(
      t.listingId,
      t.generation,
      t.productId,
      t.page
    ),
  ]
);

export const catalogInvalidations = sqliteTable(
  'catalog_invalidations',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    scopeId: text('scope_id').notNull(),
    refKey: text('ref_key'),
    refSeq: integer('ref_seq'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('catalog_invalidations_created_idx').on(t.createdAt)]
);

// Durable token bucket mirroring the Workers Cache purge rate limit.
export const cachePurgeGate = sqliteTable('cache_purge_gate', {
  id: integer('id').primaryKey(),
  tokens: real('tokens').notNull(),
  refilledAt: integer('refilled_at').notNull(),
});

// ---------- Inventory: materialised counters + append-only ledger ----------
export const stock = sqliteTable('stock', {
  sku: text('sku')
    .primaryKey()
    .references(() => variants.sku),
  onHand: integer('on_hand').notNull().default(0),
  reserved: integer('reserved').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});

export const stockLedger = sqliteTable(
  'stock_ledger',
  {
    id: text('id').primaryKey(),
    sku: text('sku').notNull(),
    deltaOnHand: integer('delta_on_hand').notNull().default(0),
    deltaReserved: integer('delta_reserved').notNull().default(0),
    reason: text('reason', {
      enum: ['restock', 'correction', 'damaged', 'return', 'reserve', 'release', 'sale'],
    }).notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('ledger_sku_idx').on(t.sku, t.createdAt)]
);

// ---------- Carts, reservations, orders ----------
export const carts = sqliteTable(
  'carts',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    status: text('status', { enum: ['open', 'checked_out', 'expired', 'converted'] })
      .notNull()
      .default('open'),
    customerEmail: text('customer_email'),
    revision: integer('revision').notNull().default(0),
    activeCheckoutId: text('active_checkout_id'),
    userId: text('user_id').references(() => user.id),
    discountId: text('discount_id'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('carts_retention_idx').on(t.status, t.expiresAt, t.id)]
);

export const cartItems = sqliteTable(
  'cart_items',
  {
    id: text('id').primaryKey(),
    cartId: text('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    qty: integer('qty').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
  },
  (t) => [uniqueIndex('cart_items_cart_sku_idx').on(t.cartId, t.sku)]
);

export const reservations = sqliteTable(
  'reservations',
  {
    id: text('id').primaryKey(),
    cartId: text('cart_id'),
    orderId: text('order_id'),
    sku: text('sku').notNull(),
    qty: integer('qty').notNull(),
    status: text('status', { enum: ['active', 'committed', 'released', 'expired'] })
      .notNull()
      .default('active'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('reservations_status_idx').on(t.status, t.expiresAt),
    index('reservations_order_idx').on(t.orderId),
    index('reservations_retention_idx').on(t.status, t.createdAt, t.id),
  ]
);

export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    number: text('number').notNull().unique(),
    status: text('status', {
      enum: [
        'pending_payment',
        'paid',
        'processing',
        'shipped',
        'delivered',
        'refunded',
        'partially_refunded',
        'canceled',
      ],
    })
      .notNull()
      .default('pending_payment'),
    paymentStatus: text('payment_status', {
      enum: ['unpaid', 'paid', 'failed', 'refunded', 'partially_refunded', 'disputed'],
    })
      .notNull()
      .default('unpaid'),
    customerEmail: text('customer_email').notNull(),
    userId: text('user_id').references(() => user.id),
    currency: text('currency').notNull().default('USD'),
    subtotalCents: integer('subtotal_cents').notNull(),
    discountCents: integer('discount_cents').notNull().default(0),
    shippingCents: integer('shipping_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull(),
    discountId: text('discount_id'),
    shippingName: text('shipping_name'),
    shippingAddressJson: text('shipping_address_json'),
    trackingNumber: text('tracking_number'),
    trackingUrl: text('tracking_url'),
    shippedAt: text('shipped_at'),
    stripeCheckoutSessionId: text('stripe_checkout_session_id').unique(),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    checkoutAttemptId: text('checkout_attempt_id').unique(),
    checkoutIntentId: text('checkout_intent_id').unique(),
    abandonedRemindedAt: text('abandoned_reminded_at'),
    reminderConsent: integer('reminder_consent', { mode: 'boolean' }).notNull().default(false),
    reminderSuppressedAt: text('reminder_suppressed_at'),
    customerIp: text('customer_ip'),
    transitionId: text('transition_id'),
    shippingCountry: text('shipping_country'),
    shippingRateId: text('shipping_rate_id'),
    restockedAt: text('restocked_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('orders_status_idx').on(t.status, t.createdAt),
    index('orders_reminder_due_idx')
      .on(t.id)
      .where(
        sql`${t.status}='canceled' AND ${t.paymentStatus}='unpaid' AND ${t.reminderConsent}=1 AND ${t.reminderSuppressedAt} IS NULL AND ${t.abandonedRemindedAt} IS NULL`
      ),
    index('orders_created_id_idx').on(t.createdAt, t.id),
    index('orders_email_idx').on(t.customerEmail),
    index('orders_user_idx').on(t.userId, t.createdAt, t.id),
    index('orders_payment_intent_idx').on(t.stripePaymentIntentId),
    index('orders_ip_retention_idx')
      .on(t.createdAt, t.id)
      .where(sql`${t.customerIp} IS NOT NULL`),
  ]
);

/** One durable record per logical purchase attempt (Phase 1). The client
 *  supplies the UUID; initiation state lives here while order/payment
 *  status stays authoritative on orders. Frozen provider payloads are
 *  replayed verbatim, never logged. */
export const checkoutIntents = sqliteTable(
  'checkout_intents',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' })
      .unique(),
    ownerType: text('owner_type', { enum: ['account', 'guest'] }).notNull(),
    userId: text('user_id').references(() => user.id),
    guestCapabilityHash: text('guest_capability_hash'),
    fingerprint: text('fingerprint').notNull(),
    stripeCustomerId: text('stripe_customer_id'),
    paymentIntentId: text('payment_intent_id'),
    shippingAddressJson: text('shipping_address_json'),
    cartId: text('cart_id'),
    cartRevision: integer('cart_revision'),
    quoteJson: text('quote_json'),
    quoteHash: text('quote_hash'),
    quoteConfirmedAt: text('quote_confirmed_at'),
    supersededBy: text('superseded_by'),
    allocationId: text('allocation_id'),
    paymentState: text('payment_state').notNull().default('awaiting_authorization'),
    paymentClaimToken: text('payment_claim_token'),
    paymentClaimExpiresAt: text('payment_claim_expires_at'),
    paymentFencing: integer('payment_fencing').notNull().default(0),
    paymentNextAt: text('payment_next_at'),
    paymentAttemptedAt: text('payment_attempted_at'),
    authorizedAt: text('authorized_at'),
    authorizationDeadlineAt: text('authorization_deadline_at'),
    capturedAt: text('captured_at'),
    cancellationAttemptedAt: text('cancellation_attempted_at'),
    cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
    state: text('state', {
      enum: [
        'reserved',
        'session_creating',
        'ready',
        'reconciliation_required',
        'canceled',
        'expired',
      ],
    })
      .notNull()
      .default('reserved'),
    providerPayloadJson: text('provider_payload_json').notNull(),
    payloadVersion: integer('payload_version').notNull().default(1),
    couponIdempotencyKey: text('coupon_idempotency_key').notNull(),
    sessionIdempotencyKey: text('session_idempotency_key').notNull(),
    stripeCouponId: text('stripe_coupon_id'),
    stripeSessionId: text('stripe_session_id').unique(),
    checkoutUrl: text('checkout_url'),
    claimToken: text('claim_token'),
    claimExpiresAt: text('claim_expires_at'),
    fencing: integer('fencing').notNull().default(0),
    sessionExpiresAt: text('session_expires_at').notNull(),
    nextReconcileAt: text('next_reconcile_at'),
    failureCode: text('failure_code'),
    firstProviderAttemptAt: text('first_provider_attempt_at'),
    providerStep: text('provider_step', { enum: ['customer', 'coupon', 'session'] }),
    creationStoppedAt: text('creation_stopped_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('checkout_intents_owner_idx').on(t.userId, t.guestCapabilityHash),
    index('checkout_intents_payment_due_idx').on(t.paymentNextAt),
    index('checkout_authorization_age_idx')
      .on(t.authorizedAt)
      .where(
        sql`${t.paymentState} NOT IN ('finalized','canceled') AND ${t.authorizedAt} IS NOT NULL`
      ),
    index('checkout_intents_payment_intent_idx').on(t.paymentIntentId),
    index('checkout_intents_cart_idx').on(t.cartId, t.createdAt),
    index('checkout_intents_recovery_idx').on(t.state, t.nextReconcileAt),
    index('checkout_intents_session_idx').on(t.stripeSessionId),
    index('checkout_intents_retention_idx').on(t.state, t.createdAt, t.id),
  ]
);

export const orderItems = sqliteTable(
  'order_items',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    title: text('title').notNull(),
    qty: integer('qty').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
  },
  (t) => [index('order_items_order_idx').on(t.orderId)]
);

export const refunds = sqliteTable(
  'refunds',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    stripeRefundId: text('stripe_refund_id'),
    requestId: text('request_id').unique(),
    purpose: text('purpose', { enum: ['staff', 'return', 'late_payment', 'external'] })
      .notNull()
      .default('staff'),
    recoveryReason: text('recovery_reason', { enum: ['capacity_unavailable', 'currency_changed'] }),
    returnId: text('return_id'),
    restock: integer('restock', { mode: 'boolean' }).notNull().default(false),
    settledAt: text('settled_at'),
    attempts: integer('attempts').notNull().default(0),
    retryAfter: text('retry_after'),
    amountCents: integer('amount_cents').notNull(),
    status: text('status', {
      enum: ['pending', 'requires_action', 'uncertain', 'succeeded', 'failed', 'canceled'],
    })
      .notNull()
      .default('pending'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('refunds_order_idx').on(t.orderId),
    index('refunds_age_due_idx').on(t.status, t.createdAt, t.id),
    index('refunds_attempt_due_idx').on(t.status, t.attempts, t.id),
  ]
);

export const returns = sqliteTable(
  'returns',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    userId: text('user_id').references(() => user.id),
    reason: text('reason').notNull().default(''),
    status: text('status', {
      enum: ['requested', 'approved', 'rejected', 'refunded', 'refund_failed'],
    })
      .notNull()
      .default('requested'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('returns_order_idx').on(t.orderId),
    index('returns_user_idx').on(t.userId),
    index('returns_status_created_id_idx').on(t.status, t.createdAt, t.id),
    uniqueIndex('returns_active_order_unique')
      .on(t.orderId)
      .where(sql`${t.status} IN ('requested','approved')`),
  ]
);

export const returnItems = sqliteTable(
  'return_items',
  {
    id: text('id').primaryKey(),
    returnId: text('return_id')
      .notNull()
      .references(() => returns.id, { onDelete: 'cascade' }),
    orderItemId: text('order_item_id')
      .notNull()
      .references(() => orderItems.id),
    sku: text('sku').notNull(),
    title: text('title').notNull(),
    qty: integer('qty').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
  },
  (t) => [
    uniqueIndex('return_items_return_item_unique').on(t.returnId, t.orderItemId),
    index('return_items_return_idx').on(t.returnId),
  ]
);

// ---------- Discounts, shipping, customers ----------
export const discounts = sqliteTable('discounts', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  type: text('type', { enum: ['percentage', 'fixed_amount'] }).notNull(),
  value: integer('value').notNull(),
  status: text('status', { enum: ['active', 'inactive'] })
    .notNull()
    .default('active'),
  minPurchaseCents: integer('min_purchase_cents').notNull().default(0),
  maxDiscountCents: integer('max_discount_cents'),
  startsAt: text('starts_at'),
  expiresAt: text('expires_at'),
  usageLimit: integer('usage_limit'),
  usagePerCustomer: integer('usage_per_customer').notNull().default(1),
  usageCount: integer('usage_count').notNull().default(0),
  stripeCouponId: text('stripe_coupon_id'),
  createdAt: text('created_at').notNull(),
});

export const discountUsage = sqliteTable(
  'discount_usage',
  {
    id: text('id').primaryKey(),
    discountId: text('discount_id')
      .notNull()
      .references(() => discounts.id),
    orderId: text('order_id').notNull(),
    customerEmail: text('customer_email').notNull(),
    amountCents: integer('amount_cents').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('discount_usage_order_idx').on(t.orderId, t.discountId),
    index('discount_usage_customer_idx').on(t.discountId, t.customerEmail),
  ]
);

export const shippingZones = sqliteTable('shipping_zones', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  countriesJson: text('countries_json').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
});

export const shippingRates = sqliteTable('shipping_rates', {
  id: text('id').primaryKey(),
  zoneId: text('zone_id')
    .notNull()
    .references(() => shippingZones.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['flat', 'weight', 'free_over'] })
    .notNull()
    .default('flat'),
  amountCents: integer('amount_cents').notNull().default(0),
  freeOverCents: integer('free_over_cents'),
  perKgCents: integer('per_kg_cents'),
});

export const addresses = sqliteTable(
  'addresses',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    label: text('label'),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    name: text('name').notNull(),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(),
    state: text('state'),
    postalCode: text('postal_code').notNull(),
    country: text('country').notNull(),
    phone: text('phone'),
  },
  (t) => [index('addresses_user_idx').on(t.userId)]
);

// ---------- Blog & content pages ----------
export const posts = sqliteTable(
  'posts',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    excerpt: text('excerpt').notNull().default(''),
    contentHtml: text('content_html').notNull().default(''),
    contentJson: text('content_json'),
    coverMediaId: text('cover_media_id').references(() => media.id),
    authorId: text('author_id').references(() => user.id),
    status: text('status', { enum: ['draft', 'scheduled', 'published'] })
      .notNull()
      .default('draft'),
    publishedAt: text('published_at'),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('posts_status_idx').on(t.status, t.publishedAt),
    index('posts_status_published_id_idx').on(t.status, t.publishedAt, t.id),
  ]
);

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
});

export const postTags = sqliteTable('post_tags', {
  postId: text('post_id')
    .notNull()
    .references(() => posts.id, { onDelete: 'cascade' }),
  tagId: text('tag_id')
    .notNull()
    .references(() => tags.id, { onDelete: 'cascade' }),
});

export const pages = sqliteTable('pages', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  contentHtml: text('content_html').notNull().default(''),
  seoTitle: text('seo_title'),
  seoDescription: text('seo_description'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ---------- Platform: inbox, outbox, audit, redirects ----------
export const webhookInbox = sqliteTable(
  'webhook_inbox',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull().default('stripe'),
    eventId: text('event_id').notNull().unique(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status', { enum: ['pending', 'processed', 'failed', 'dead'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    retryAfter: text('retry_after'),
    receivedAt: text('received_at').notNull(),
    processedAt: text('processed_at'),
  },
  (t) => [index('webhook_inbox_due_idx').on(t.status, t.retryAfter, t.receivedAt)]
);

export const outbox = sqliteTable(
  'outbox',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status', { enum: ['pending', 'sending', 'sent', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    retryAfter: text('retry_after'),
    claimedAt: text('claimed_at'),
    createdAt: text('created_at').notNull(),
    sentAt: text('sent_at'),
  },
  (t) => [
    index('outbox_status_idx').on(t.status, t.createdAt),
    index('outbox_claim_due_idx')
      .on(t.status, t.claimedAt, t.id)
      .where(sql`${t.attempts}<3`),
  ]
);

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  actorUserId: text('actor_user_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  detailsJson: text('details_json'),
  createdAt: text('created_at').notNull(),
});

export const redirects = sqliteTable('redirects', {
  id: text('id').primaryKey(),
  fromPath: text('from_path').notNull().unique(),
  toPath: text('to_path').notNull(),
  createdAt: text('created_at').notNull(),
});

// ---------- Drizzle relations (typed joins via db.query ... with) ----------
export const productsRelations = relations(products, ({ many }) => ({
  variants: many(variants),
  mediaLinks: many(productMedia),
  collectionLinks: many(productCollections),
}));

export const variantsRelations = relations(variants, ({ one }) => ({
  product: one(products, { fields: [variants.productId], references: [products.id] }),
  stockRow: one(stock, { fields: [variants.sku], references: [stock.sku] }),
}));

export const productMediaRelations = relations(productMedia, ({ one }) => ({
  product: one(products, { fields: [productMedia.productId], references: [products.id] }),
  media: one(media, { fields: [productMedia.mediaId], references: [media.id] }),
}));

export const collectionsRelations = relations(collections, ({ many }) => ({
  productLinks: many(productCollections),
}));

export const productCollectionsRelations = relations(productCollections, ({ one }) => ({
  product: one(products, { fields: [productCollections.productId], references: [products.id] }),
  collection: one(collections, {
    fields: [productCollections.collectionId],
    references: [collections.id],
  }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(user, { fields: [orders.userId], references: [user.id] }),
  items: many(orderItems),
  refunds: many(refunds),
  returns: many(returns),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
}));

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  orders: many(orders),
  addresses: many(addresses),
}));

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(user, { fields: [posts.authorId], references: [user.id] }),
}));

// Status unions derived from the columns themselves, so UI and server code
// cannot drift from the stored value sets.
export type OrderStatus = (typeof orders.$inferSelect)['status'];
export type PaymentStatus = (typeof orders.$inferSelect)['paymentStatus'];
export type ProductStatus = (typeof products.$inferSelect)['status'];
export type PostStatus = (typeof posts.$inferSelect)['status'];
export type RefundStatus = (typeof refunds.$inferSelect)['status'];
export type ReturnStatus = (typeof returns.$inferSelect)['status'];
export type ReservationStatus = (typeof reservations.$inferSelect)['status'];
export type DiscountStatus = (typeof discounts.$inferSelect)['status'];
export type AnyStatus =
  | OrderStatus
  | PaymentStatus
  | ProductStatus
  | PostStatus
  | RefundStatus
  | ReturnStatus
  | ReservationStatus
  | DiscountStatus;

import { loadDirectoryNode, resolveDirectoryRevision } from './catalog-read';
import { runCatalogGcUnit, type ReclaimKv } from './catalog-gc';
import { repairCatalogUnit } from './catalog-repair';
import { verifyChangedReferences } from './catalog-operations';
import { publishedMediaContent } from './media-delivery';
import { listPublishedProductsByIds, parseRule } from './catalog';
import {
  BudgetExhausted,
  CatalogBudget,
  claimCatalogLease,
  countedDb,
  countedKv,
  fencedCatalogDb,
  releaseCatalogLease,
  type CatalogLease,
} from './catalog-exec';
import { getSettings } from './settings';
import {
  ALL_LISTING,
  COLLECTION_PAGE_SIZE,
  HOME_PAGE_SIZE,
  LAYOUT_REF_KEY,
  collectionMetaKey,
  contentRevision,
  directoryKey,
  editorialKey,
  layoutKey,
  listingPageKey,
  listingRefKey,
  productDocKey,
  productSlugKey,
  serializeListingPage,
  listingPageRevision,
  immutableDocumentKey,
  COLLECTION_INDEX,
  POSTS_INDEX,
  DIRECTORY_FANOUT,
  FEATURED_INDEX,
  ARTIFACT_BYTE_LIMIT,
  type CatalogCard,
  type DirectoryNode,
  type ListingPage,
  type ListingReference,
  type ProductDocument,
} from './catalog-models';
import { MAX_RAILS } from '../lib/catalog-limits';

// Partitioned catalog publisher (Phase 3A). Builds the D1 read-model
// projections and the versioned KV namespace alongside the live
// snapshot path; nothing here is wired to change capture or readers
// until 3B. Builds are content-addressed: unchanged cards, documents
// and listing generations produce no writes, so a re-run is a no-op.

const now = () => new Date().toISOString();
const POST_METADATA_FIELDS = `(SELECT r2_key FROM media WHERE id=source.cover_media_id AND ready=1 AND deletion_pending=0) AS cover_key,
 (SELECT public_url FROM media WHERE id=source.cover_media_id AND ready=1 AND deletion_pending=0) AS cover_public_url,
 (SELECT name FROM user WHERE id=source.author_id) AS author_name,
 (SELECT GROUP_CONCAT(name, ', ') FROM (SELECT t.name FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=source.id ORDER BY t.name,t.id)) AS tags`;
type PostMetadata = {
  cover_key: string | null;
  cover_public_url: string | null;
  author_name: string | null;
  tags: string | null;
};
// Leave two bind slots for listing/generation predicates.
const CHUNK = 88;
// Upper bounds on D1 statements (fenced writes count their guard) for
// one build step outside the self-guarding cards phase, one published
// editorial document, and one layout republish.
const BUILD_STEP_STATEMENTS = 7;
const EDITORIAL_DOC_STATEMENTS = 10;
const LAYOUT_STATEMENTS = 14;
const RETIRE_STATEMENTS = 7;

type KvLike = ReclaimKv & {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
};

// Batch slices stay small in both statement count and bound bytes:
// page payloads and JSON-chunk binds are kilobytes each, and an
// oversized batch request is a hard transport failure, not a slow one.
// Each slice is atomic, so one retry after a transport-level failure
// (TypeError before any response) cannot double-apply it: either the
// slice never ran and the retry applies it, or it ran and the retry
// fails loudly on a constraint instead of corrupting state.
function placeholders(n: number) {
  return Array.from({ length: n }, () => '?').join(',');
}

type InvalidationEntry = { scope: string; scopeId: string; listingId?: string };

/** Records pending Workers Cache invalidations for what a publish
 *  changed (Phase 4). The gateway drains these through the
 *  cache-owning entrypoint; until then the 60 s TTL bounds staleness. */
async function recordInvalidations(db: D1Database, entries: InvalidationEntry[]): Promise<void> {
  const statements = invalidationStatements(db, entries);
  if (statements.length) await db.batch(statements);
}

/** The inserts for `entries`, for commit batches that must record
 *  their invalidations atomically with the state they invalidate. */
function invalidationStatements(
  db: D1Database,
  entries: InvalidationEntry[]
): D1PreparedStatement[] {
  const seen = new Set<string>();
  const rows = entries.filter((e) => {
    const key = `${e.scope}:${e.scopeId}`;
    if (!e.scopeId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const at = now();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    statements.push(
      db
        .prepare(
          `WITH entries AS(SELECT json_extract(value,'$.scope') AS scope,json_extract(value,'$.scopeId') AS scope_id,json_extract(value,'$.listingId') AS listing_id FROM json_each(?)), refs AS(SELECT scope,scope_id,CASE WHEN scope='layout' THEN 'layout' WHEN scope='listing' THEN 'listing:'||COALESCE(listing_id,(SELECT id FROM collections WHERE slug=scope_id),scope_id) ELSE NULL END AS ref FROM entries), targets AS(SELECT * FROM refs UNION ALL SELECT 'listing','${FEATURED_INDEX}',ref FROM refs WHERE scope='listing' AND EXISTS(SELECT 1 FROM collections WHERE id=substr(ref,9) AND featured_rank IS NOT NULL))
         INSERT INTO catalog_invalidations (id, scope, scope_id, created_at,ref_key,ref_seq)
         SELECT lower(hex(randomblob(16))),scope,scope_id,?,(SELECT ref_key FROM catalog_ref_state WHERE ref_key=ref),(SELECT committed_seq FROM catalog_ref_state WHERE ref_key=ref) FROM targets`
        )
        .bind(JSON.stringify(rows.slice(i, i + 500)), at)
    );
  }
  return statements;
}

type PutFn = (key: string, value: string) => Promise<void>;

/** Store one immutable directory node: D1 copy first (durable exact
 *  fallback), then KV. Content-addressed, so an existing node is not
 *  rewritten. Returns the node hash. */
/** Store directory nodes in bulk: one existence query and one
 *  bulk insert for the whole tree, so a 100k-page directory costs a
 *  constant number of statements, not one per node. KV receives
 *  only nodes D1 did not already hold (all of them under repair,
 *  where a D1 mirror proves nothing about KV). */
async function storeDirectoryNodes(
  db: D1Database,
  kv: KvLike | undefined,
  put: PutFn,
  listingId: string,
  nodes: { hash: string; payload: string }[],
  forceKv = false
): Promise<void> {
  if (!nodes.length) return;
  const hashes = nodes.map((n) => n.hash);
  const existing = await db
    .prepare('SELECT hash FROM catalog_ref_chunks WHERE hash IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(hashes))
    .all<{ hash: string }>();
  const have = new Set(existing.results.map((r) => r.hash));
  const missing = nodes.filter((n) => !have.has(n.hash));
  if (missing.length) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO catalog_ref_chunks (hash, listing_id, payload_json, created_at)
         SELECT json_extract(value, '$.hash'), ?, json_extract(value, '$.payload'), ? FROM json_each(?)`
      )
      .bind(listingId, now(), JSON.stringify(missing))
      .run();
  }
  if (kv) {
    for (const node of nodes)
      if (forceKv || (await kv.get(directoryKey(node.hash))) !== node.payload)
        await put(directoryKey(node.hash), node.payload);
  }
}

/** Build the fixed-fan-out directory over ordered page revisions and
 *  return its root hash. Each level holds at most DIRECTORY_FANOUT
 *  entries; larger catalogs add levels, never wider nodes. */
async function buildDirectory(
  db: D1Database,
  kv: KvLike | undefined,
  put: PutFn,
  listingId: string,
  pageRevisions: { page: number; revision: string }[],
  forceKv = false
): Promise<string> {
  const entries =
    pageRevisions.length === 0 ? [{ page: 1, revision: contentRevision('[]') }] : pageRevisions;
  const nodes: { hash: string; payload: string }[] = [];
  const nodeOf = (node: DirectoryNode): { hash: string; payload: string } => {
    const payload = JSON.stringify(node);
    return { hash: contentRevision(payload), payload };
  };
  let level: { from: number; to: number; hash: string }[] = [];
  for (let i = 0; i < entries.length; i += DIRECTORY_FANOUT) {
    const slice = entries.slice(i, i + DIRECTORY_FANOUT);
    const node = nodeOf({ kind: 'pages', entries: slice });
    nodes.push(node);
    level.push({ from: slice[0]!.page, to: slice[slice.length - 1]!.page, hash: node.hash });
  }
  while (level.length > 1) {
    const next: { from: number; to: number; hash: string }[] = [];
    for (let i = 0; i < level.length; i += DIRECTORY_FANOUT) {
      const slice = level.slice(i, i + DIRECTORY_FANOUT);
      const node = nodeOf({ kind: 'index', entries: slice });
      nodes.push(node);
      next.push({ from: slice[0]!.from, to: slice[slice.length - 1]!.to, hash: node.hash });
    }
    level = next;
  }
  await storeDirectoryNodes(db, kv, put, listingId, nodes, forceKv);
  return level[0]!.hash;
}

async function patchDirectory(
  db: D1Database,
  kv: KvLike | undefined,
  put: PutFn,
  listingId: string,
  hash: string,
  page: number,
  revision: string
): Promise<string> {
  const node = await loadDirectoryNode(db, undefined, hash);
  if (!node) throw new Error('Committed catalog directory is missing');
  if (node.kind === 'pages') {
    const entry = node.entries.find((e) => e.page === page);
    if (!entry) throw new Error('Catalog page is absent from directory');
    entry.revision = revision;
  } else {
    const entry = node.entries.find((e) => page >= e.from && page <= e.to);
    if (!entry) throw new Error('Catalog directory path is missing');
    entry.hash = await patchDirectory(db, kv, put, listingId, entry.hash, page, revision);
  }
  const payload = JSON.stringify(node),
    nextHash = contentRevision(payload);
  await storeDirectoryNodes(db, kv, put, listingId, [{ hash: nextHash, payload }]);
  return nextHash;
}

/** Resolve the exact page revision a pinned directory root names.
 *  Never a "newest <= pin" guess: A -> B -> A reuse resolves because
 *  the directory entry itself carries the revision hash. */
export type ListingPublication = {
  listingId: string;
  generation: number;
  pageSize: number;
  total: number;
  pageCount: number;
  rootHash: string;
};

/** Activation step 3: atomically commit the D1 publication identity,
 *  exact version mapping and per-reference committed position. The
 *  sequence guard aborts the whole commit if another publisher
 *  committed first — D1 committed state can never roll back. Steps
 *  1-2 (immutable payloads/directory in KV) already happened; step 4
 *  (mutable KV reference) and step 5 (delivery confirmation) follow
 *  in deliverListingRef, and lagging delivery is repaired from the
 *  committed history, never by adopting stale KV data. */
/** Mirror one published document into D1 (Round 2 document
 *  storage). Keyed by KV key; revision is the artifact hash of the
 *  complete serialized payload. */
export async function mirrorDocument(
  db: D1Database,
  kind: string,
  key: string,
  revision: string,
  payloadJson: string
): Promise<void> {
  if (new TextEncoder().encode(payloadJson).byteLength > ARTIFACT_BYTE_LIMIT)
    throw new Error('Catalog document exceeds artifact byte budget');
  await db
    .prepare(
      `INSERT INTO catalog_documents (key, kind, revision, payload_json, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json, updated_at = excluded.updated_at WHERE catalog_documents.revision!=excluded.revision OR catalog_documents.payload_json!=excluded.payload_json`
    )
    .bind(key, kind, revision, payloadJson, now())
    .run();
}

async function publishDocument(
  db: D1Database,
  kv: KvLike | undefined,
  put: PutFn,
  kind: string,
  base: string,
  value: string
): Promise<void> {
  if (new TextEncoder().encode(value).byteLength > ARTIFACT_BYTE_LIMIT)
    throw new Error('Catalog artifact exceeds byte budget');
  const revision = contentRevision(value),
    key = immutableDocumentKey(base, revision);
  if (!kv || (await kv.get(key)) !== value) await put(key, value);
  await mirrorDocument(db, kind, key, revision, value);
  const pointer = JSON.stringify({ key, revision });
  if (!kv || (await kv.get(base)) !== pointer) await put(base, pointer);
  await mirrorDocument(db, `${kind}-pointer`, base, contentRevision(pointer), pointer);
}

async function unpublishDocument(
  db: D1Database,
  kv: KvLike | undefined,
  base: string
): Promise<void> {
  if (kv?.delete) await kv.delete(base);
  await db.prepare('DELETE FROM catalog_documents WHERE key=?').bind(base).run();
}

/** Points a renamed slug, and every slug redirected to it before, at
 *  the current path. A slug that is live again keeps its own pointer. */
async function publishMoves(
  db: D1Database,
  put: PutFn,
  section: 'products' | 'blog',
  slug: string,
  previous: string | null
): Promise<void> {
  const to = `/${section}/${slug}`,
    start = section.length + 3;
  const moved = await db
    .prepare(
      `WITH RECURSIVE moved(path) AS (SELECT value FROM json_each(?) UNION SELECT r.from_path FROM redirects r JOIN moved m ON r.to_path = m.path)
       SELECT substr(path, ?) AS slug FROM moved WHERE path <> ? AND path LIKE ? AND NOT EXISTS (SELECT 1 FROM ${section === 'products' ? 'products' : 'posts'} t WHERE t.slug = substr(path, ?))`
    )
    .bind(
      JSON.stringify(previous === null ? [to] : [to, `/${section}/${previous}`]),
      start,
      to,
      `/${section}/%`,
      start
    )
    .all<{ slug: string }>();
  const keys = moved.results.map((r) =>
    section === 'products' ? productSlugKey(r.slug) : editorialKey('post', r.slug)
  );
  const pointer = JSON.stringify({ redirect: to });
  for (const key of keys) await put(key, pointer);
  if (section === 'blog' && keys.length)
    await db
      .prepare('DELETE FROM catalog_documents WHERE key IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(keys))
      .run();
}

type PublishedIndex = typeof COLLECTION_INDEX | typeof POSTS_INDEX;
// Metadata is part of the listing reference even when its cards are unchanged.
const metadataChangedSql = `EXISTS(SELECT 1 FROM collections c JOIN catalog_documents d ON d.key='${collectionMetaKey('').slice(0, -5)}'||c.slug||':meta'
  WHERE c.id=b.listing_id AND NOT EXISTS(SELECT 1 FROM catalog_ref_state r JOIN catalog_ref_documents rd ON rd.ref_key=r.ref_key AND rd.publication_seq=r.committed_seq
    WHERE r.ref_key='listing:'||b.listing_id AND rd.document_key=json_extract(d.payload_json,'$.key')))`;
type IndexProgress = {
  stage: 'scan' | 'directory' | 'activate';
  generation: number;
  page: number;
  total: number;
  seen: number;
  cursorId: string;
  cursorTitle: string;
  cursorDate: string | null;
  started: boolean;
  at: string;
};

function publishedIndexSchedule(db: D1Database, listingId: PublishedIndex): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO catalog_builds(id,kind,state,phase,state_json,scope_listing_id,created_at,updated_at) VALUES(?,'index','building','index','{}',?,?,?) ON CONFLICT(id) DO UPDATE SET state='building',phase='index',state_json='{}',updated_at=excluded.updated_at WHERE state='done'"
    )
    .bind(`index:${listingId}`, listingId, now(), now());
}

/** One index page, directory preparation, or activation per delivery. */
async function processPublishedIndex(
  db: D1Database,
  kv: KvLike | undefined,
  put: PutFn,
  buildId: string,
  listingId: PublishedIndex,
  parentId: string | null
): Promise<boolean> {
  const collection = listingId === COLLECTION_INDEX,
    pageSize = collection ? 48 : 50;
  const entity = collection ? 'collection' : 'post';
  const epochSql =
    'SELECT COALESCE(SUM(target_revision),0) AS revision FROM catalog_work WHERE entity_type=?';
  const build = await db
    .prepare('SELECT state,state_json,source_revision FROM catalog_builds WHERE id=?')
    .bind(buildId)
    .first<{ state: string; state_json: string; source_revision: number | null }>();
  if (build?.state === 'done') return true;
  let state =
    build?.state_json && build.state_json !== '{}'
      ? (JSON.parse(build.state_json) as IndexProgress)
      : null;
  if (!state) {
    const at = now();
    const epoch = await db.prepare(epochSql).bind(entity).first<{ revision: number }>();
    const count = collection
      ? await db.prepare('SELECT COUNT(*) AS n FROM collections').first<{ n: number }>()
      : await db
          .prepare(
            "SELECT COUNT(*) AS n FROM posts WHERE (status='published' AND (published_at IS NULL OR published_at<=?)) OR (status='scheduled' AND published_at<=?)"
          )
          .bind(at, at)
          .first<{ n: number }>();
    const active = await db
      .prepare('SELECT generation FROM catalog_listings WHERE listing_id=? AND active=1')
      .bind(listingId)
      .first<{ generation: number }>();
    state = {
      stage: 'scan',
      generation: (active?.generation ?? 0) + 1,
      page: 1,
      total: count?.n ?? 0,
      seen: 0,
      cursorId: '',
      cursorTitle: '',
      cursorDate: null,
      started: false,
      at,
    };
    await db.batch([
      db
        .prepare(
          "INSERT INTO catalog_builds(id,kind,state,phase,state_json,parent_id,scope_listing_id,source_revision,created_at,updated_at) VALUES(?,'index',?,'index',?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json,source_revision=excluded.source_revision,updated_at=excluded.updated_at"
        )
        .bind(
          buildId,
          parentId ? 'indexing' : 'building',
          JSON.stringify(state),
          parentId,
          listingId,
          epoch?.revision ?? 0,
          at,
          at
        ),
      db
        .prepare(
          "INSERT INTO catalog_listings(listing_id,generation,page_size,page_count,total,active,state,updated_at) VALUES(?,?,?,?,?,0,'building',?) ON CONFLICT(listing_id,generation) DO UPDATE SET page_count=excluded.page_count,total=excluded.total,state='building',updated_at=excluded.updated_at"
        )
        .bind(
          listingId,
          state.generation,
          pageSize,
          Math.max(1, Math.ceil(state.total / pageSize)),
          state.total,
          at
        ),
      db
        .prepare('DELETE FROM catalog_build_pages WHERE build_id=? AND listing_id=?')
        .bind(buildId, listingId),
    ]);
    return false;
  }
  const save = () =>
    db
      .prepare('UPDATE catalog_builds SET state_json=?,updated_at=? WHERE id=?')
      .bind(JSON.stringify(state), now(), buildId)
      .run();
  if (state.stage === 'scan') {
    let rows: { id: string; title?: string; published_at?: string | null }[];
    if (collection) {
      rows = (
        await db
          .prepare(
            `SELECT id,title FROM collections ${state.started ? 'WHERE (title,id)>(?,?)' : ''} ORDER BY title,id LIMIT 48`
          )
          .bind(...(state.started ? [state.cursorTitle, state.cursorId] : []))
          .all<{ id: string; title: string }>()
      ).results;
    } else {
      const cursor = state.started
        ? state.cursorDate === null
          ? ' AND published_at IS NULL AND id<?'
          : ' AND (published_at<? OR (published_at=? AND id<?) OR published_at IS NULL)'
        : '';
      const cursorArgs = state.started
        ? state.cursorDate === null
          ? [state.cursorId]
          : [state.cursorDate, state.cursorDate, state.cursorId]
        : [];
      rows = (
        await db
          .prepare(
            `WITH p AS (SELECT id,published_at FROM posts WHERE status='published' AND (published_at IS NULL OR published_at<=?)${cursor} ORDER BY published_at DESC,id DESC LIMIT 50),s AS (SELECT id,published_at FROM posts WHERE status='scheduled' AND published_at<=?${cursor} ORDER BY published_at DESC,id DESC LIMIT 50) SELECT * FROM (SELECT * FROM p UNION ALL SELECT * FROM s) ORDER BY published_at DESC,id DESC LIMIT 50`
          )
          .bind(state.at, ...cursorArgs, state.at, ...cursorArgs)
          .all<{ id: string; published_at: string | null }>()
      ).results;
    }
    if (rows.length || !state.started) {
      const ids = rows.map((row) => row.id);
      const data = collection
        ? (
            await db
              .prepare(
                'SELECT id,slug,title,description,seo_title AS seoTitle,seo_description AS seoDescription,kind,rule_json AS ruleJson FROM collections WHERE id IN (SELECT value FROM json_each(?))'
              )
              .bind(JSON.stringify(ids))
              .all<Record<string, unknown>>()
          ).results
        : (
            await db
              .prepare(
                "SELECT p.id,p.slug,p.title,p.excerpt,COALESCE(p.published_at,'') AS published_at,m.r2_key AS cover_key,m.public_url AS cover_public_url FROM posts p LEFT JOIN media m ON m.id=p.cover_media_id AND m.ready=1 AND m.deletion_pending=0 WHERE p.id IN (SELECT value FROM json_each(?))"
              )
              .bind(JSON.stringify(ids))
              .all<Record<string, unknown>>()
          ).results;
      const byId = new Map(data.map((row) => [row.id, row]));
      const items = ids.map((id) => byId.get(id)).filter(Boolean);
      const payload = JSON.stringify({ listingId, page: state.page, pageSize, items });
      const revision = contentRevision(payload),
        key = listingPageKey(listingId, state.page, revision);
      if (!kv || (await kv.get(key)) !== payload) await put(key, payload);
      await db.batch([
        db
          .prepare(
            'INSERT OR IGNORE INTO catalog_listing_page_revisions(listing_id,generation,page,revision,payload_json,created_at) VALUES(?,?,?,?,?,?)'
          )
          .bind(listingId, state.generation, state.page, revision, payload, now()),
        db
          .prepare(
            'INSERT OR REPLACE INTO catalog_build_pages(build_id,listing_id,page,revision) VALUES(?,?,?,?)'
          )
          .bind(buildId, listingId, state.page, revision),
      ]);
      state.seen += items.length;
      state.page++;
      const last = rows.at(-1);
      if (last) {
        state.cursorId = last.id;
        state.cursorTitle = last.title ?? '';
        state.cursorDate = last.published_at ?? null;
      }
      state.started = true;
    }
    if (rows.length < pageSize) state.stage = 'directory';
    await save();
    return false;
  }
  const epoch = await db.prepare(epochSql).bind(entity).first<{ revision: number }>();
  if (epoch?.revision !== build?.source_revision || state.seen !== state.total) {
    await db.prepare("UPDATE catalog_builds SET state_json='{}' WHERE id=?").bind(buildId).run();
    return false;
  }
  if (state.stage === 'directory') {
    const pageCount = Math.max(1, Math.ceil(state.total / pageSize));
    if (pageCount > 4500) throw new Error('Published index directory exceeds invocation capacity');
    const revisions = await db
      .prepare(
        'SELECT page,revision FROM catalog_build_pages WHERE build_id=? AND listing_id=? ORDER BY page LIMIT 4500'
      )
      .bind(buildId, listingId)
      .all<{ page: number; revision: string }>();
    const root = await buildDirectory(db, kv, put, listingId, revisions.results);
    const previous = await db
      .prepare('SELECT root_hash FROM catalog_ref_state WHERE ref_key=?')
      .bind(`listing:${listingId}`)
      .first<{ root_hash: string | null }>();
    if (previous?.root_hash === root) {
      await db
        .prepare("UPDATE catalog_builds SET state='done',phase='done',updated_at=? WHERE id=?")
        .bind(now(), buildId)
        .run();
      return true;
    }
    await db
      .prepare(
        'INSERT INTO catalog_build_listings(build_id,listing_id,generation,root_hash,page_count,total,changed) VALUES(?,?,?,?,?,?,1) ON CONFLICT(build_id,listing_id) DO UPDATE SET generation=excluded.generation,root_hash=excluded.root_hash,page_count=excluded.page_count,total=excluded.total,changed=1'
      )
      .bind(buildId, listingId, state.generation, root, pageCount, state.total)
      .run();
    state.stage = 'activate';
    await save();
    return false;
  }
  const staged = await db
    .prepare(
      'SELECT root_hash,page_count FROM catalog_build_listings WHERE build_id=? AND listing_id=?'
    )
    .bind(buildId, listingId)
    .first<{ root_hash: string; page_count: number }>();
  if (!staged) throw new Error('Prepared index publication is missing');
  await commitListingPublication(
    db,
    {
      listingId,
      generation: state.generation,
      pageSize,
      total: state.total,
      pageCount: staged.page_count,
      rootHash: staged.root_hash,
    },
    [
      db
        .prepare(
          'INSERT INTO batch_guard SELECT 1 WHERE (SELECT COALESCE(SUM(target_revision),0) FROM catalog_work WHERE entity_type=?)<>?'
        )
        .bind(entity, build!.source_revision),
      db
        .prepare("UPDATE catalog_builds SET state='done',phase='done',updated_at=? WHERE id=?")
        .bind(now(), buildId),
      db
        .prepare('UPDATE catalog_build_listings SET changed=2 WHERE build_id=? AND listing_id=?')
        .bind(buildId, listingId),
      ...invalidationStatements(db, [{ scope: 'listing', scopeId: listingId }]),
    ]
  );
  return true;
}

/** Record which page documents a committed listing publication
 *  used, keyed by reference + publication sequence. Bounded: one
 *  json_each statement over the generation's exact page rows. */
async function commitListingPublication(
  db: D1Database,
  pub: ListingPublication,
  progress?: D1PreparedStatement | D1PreparedStatement[]
): Promise<number> {
  const state = await db
    .prepare('SELECT publication_seq FROM catalog_publication_state WHERE id = 1')
    .first<{ publication_seq: number }>();
  const seq = (state?.publication_seq ?? 0) + 1;
  const at = now();
  const refKey = `listing:${pub.listingId}`;
  const meta =
    pub.listingId === ALL_LISTING || pub.listingId.startsWith('@')
      ? null
      : await db
          .prepare(
            "SELECT d.payload_json FROM collections c JOIN catalog_documents d ON d.key=?||c.slug||':meta' WHERE c.id=?"
          )
          .bind(collectionMetaKey('').slice(0, -5), pub.listingId)
          .first<{ payload_json: string }>();
  const metadataKey = meta ? (JSON.parse(meta.payload_json) as { key?: string }).key : undefined;
  // The exact pending delivery is committed with the publication so
  // an interrupted delivery retries the identical payload.
  const pendingPayload = JSON.stringify({
    listingId: pub.listingId,
    generation: pub.generation,
    publicationSeq: seq,
    pageSize: pub.pageSize,
    total: pub.total,
    pageCount: pub.pageCount,
    rootHash: pub.rootHash,
    ...(metadataKey ? { metadataKey } : {}),
  } satisfies ListingReference);
  await db.batch([
    db
      .prepare(
        'INSERT INTO batch_guard SELECT 1 WHERE (SELECT publication_seq FROM catalog_publication_state WHERE id = 1) IS NOT ?'
      )
      .bind(seq - 1),
    db
      .prepare(
        'UPDATE catalog_publication_state SET publication_seq = ?, updated_at = ? WHERE id = 1'
      )
      .bind(seq, at),
    db
      .prepare(
        'UPDATE catalog_listing_ref_history SET retired_at = ? WHERE listing_id = ? AND retired_at IS NULL'
      )
      .bind(at, pub.listingId),
    db
      .prepare(
        `INSERT INTO catalog_listing_ref_history (listing_id, generation, publication_seq, root_hash, page_count, total, page_size, retired_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .bind(
        pub.listingId,
        pub.generation,
        seq,
        pub.rootHash,
        pub.pageCount,
        pub.total,
        pub.pageSize,
        at
      ),
    db
      .prepare(
        "UPDATE catalog_listings SET active = 0, state = 'superseded', updated_at = ? WHERE listing_id = ? AND active = 1 AND generation != ?"
      )
      .bind(at, pub.listingId, pub.generation),
    db
      .prepare(
        "UPDATE catalog_listings SET active = 1, state = 'active', updated_at = ? WHERE listing_id = ? AND generation = ?"
      )
      .bind(at, pub.listingId, pub.generation),
    db
      .prepare(
        `INSERT INTO catalog_ref_state (ref_key, committed_seq, delivered_seq, root_hash, pending_payload, delivery_failure, updated_at) VALUES (?, ?, 0, ?, ?, NULL, ?)
         ON CONFLICT(ref_key) DO UPDATE SET committed_seq = excluded.committed_seq, root_hash = excluded.root_hash, pending_payload = excluded.pending_payload, delivery_failure = NULL, updated_at = excluded.updated_at`
      )
      .bind(refKey, seq, pub.rootHash, pendingPayload, at),
    db
      .prepare(
        'INSERT OR IGNORE INTO catalog_ref_documents(ref_key,publication_seq,document_key) VALUES(?,?,?)'
      )
      .bind(refKey, seq, directoryKey(pub.rootHash)),
    ...(metadataKey
      ? [
          db
            .prepare(
              'INSERT OR IGNORE INTO catalog_ref_documents(ref_key,publication_seq,document_key) VALUES(?,?,?)'
            )
            .bind(refKey, seq, metadataKey),
        ]
      : []),
    ...(progress ? (Array.isArray(progress) ? progress : [progress]) : []),
  ]);
  return seq;
}

/** Activation steps 4-5: publish the mutable KV reference, then mark
 *  delivery confirmed in D1. A failed or late KV write leaves
 *  delivered_seq behind committed_seq; repairPendingDeliveries
 *  repairs delivery from committed history. The write time is
 *  persisted per key (KV per-key write-rate limit). */
async function deliverListingRef(
  db: D1Database,
  kv: KvLike | undefined,
  put: PutFn,
  pub: ListingPublication,
  seq: number,
  lease?: CatalogLease
): Promise<void> {
  if (!kv) return;
  const previous = await db
    .prepare(
      'SELECT last_write_at,pending_payload,committed_seq FROM catalog_ref_state WHERE ref_key=?'
    )
    .bind(`listing:${pub.listingId}`)
    .first<{
      last_write_at: string | null;
      pending_payload: string | null;
      committed_seq: number;
    }>();
  if (!previous?.pending_payload || previous.committed_seq !== seq) return;
  if (lease && previous?.last_write_at && Date.now() - Date.parse(previous.last_write_at) < 1100)
    return;
  await put(listingRefKey(pub.listingId), previous.pending_payload);
  // Guarded confirmation: only confirm if the committed sequence is
  // still the one just delivered (a newer commit supersedes safely).
  await db
    .prepare(
      'UPDATE catalog_ref_state SET delivered_seq = ?, pending_payload = NULL, delivery_failure = NULL, last_write_at = ?, updated_at = ? WHERE ref_key = ? AND committed_seq = ?'
    )
    .bind(seq, now(), now(), `listing:${pub.listingId}`, seq)
    .run();
}

function refKvKey(refKey: string): string | null {
  if (refKey.startsWith('listing:')) return listingRefKey(refKey.slice('listing:'.length));
  if (refKey === 'layout') return LAYOUT_REF_KEY;
  return null;
}

/** Deliver/repair mutable references from committed D1 state,
 *  independently of delivered_seq: rows with an exact pending payload
 *  deliver it verbatim; lagging rows without one are reconstructed
 *  from committed history (listings) or the committed layout
 *  revision. Failures record retry time + failure and stay pending.
 *  A newer commit supersedes an obsolete pending payload safely:
 *  confirmation is guarded by the committed sequence read. */
export async function repairPendingDeliveries(
  db: D1Database,
  kv: KvLike | undefined,
  put: PutFn,
  opts: { limit?: number; budget: CatalogBudget }
): Promise<number> {
  if (!kv) return 0;
  const limit = opts.limit ?? 5;
  const lagging = await db
    .prepare(
      `SELECT ref_key, committed_seq, delivered_seq, root_hash, pending_payload, last_write_at FROM catalog_ref_state
       WHERE (pending_payload IS NOT NULL OR committed_seq > delivered_seq)
         AND (delivery_retry_at IS NULL OR delivery_retry_at <= ?)
       ORDER BY committed_seq ASC LIMIT ?`
    )
    .bind(now(), limit)
    .all<{
      ref_key: string;
      committed_seq: number;
      delivered_seq: number;
      root_hash: string | null;
      pending_payload: string | null;
    }>();
  let repaired = 0;
  for (const row of lagging.results) {
    if (opts.budget.spent()) break;
    const key = refKvKey(row.ref_key);
    if (!key) continue;
    // Per-key write timing (KV allows ~1 write/second/key): a key
    // written moments ago keeps its pending delivery for the next
    // unit instead of burning a rejected write.
    const lastWrite = (row as { last_write_at?: string | null }).last_write_at;
    if (lastWrite && Date.now() - Date.parse(lastWrite) < 1000) continue;
    let payload = row.pending_payload;
    if (!payload && row.ref_key.startsWith('listing:')) {
      const listingId = row.ref_key.slice('listing:'.length);
      const hist = await db
        .prepare(
          `SELECT h.generation,h.root_hash,h.page_count,h.total,h.page_size,
            (SELECT rd.document_key FROM catalog_ref_documents rd JOIN catalog_documents d ON d.key=rd.document_key
             WHERE rd.ref_key=? AND rd.publication_seq=h.publication_seq AND d.kind='collection-meta' LIMIT 1) AS metadata_key
           FROM catalog_listing_ref_history h WHERE h.listing_id=? AND h.publication_seq=?`
        )
        .bind(row.ref_key, listingId, row.committed_seq)
        .first<{
          generation: number;
          root_hash: string;
          page_count: number;
          total: number;
          page_size: number;
          metadata_key: string | null;
        }>();
      if (!hist) continue;
      payload = JSON.stringify({
        listingId,
        generation: hist.generation,
        publicationSeq: row.committed_seq,
        pageSize: hist.page_size,
        total: hist.total,
        pageCount: hist.page_count,
        rootHash: hist.root_hash,
        ...(hist.metadata_key ? { metadataKey: hist.metadata_key } : {}),
      } satisfies ListingReference);
    }
    if (!payload && row.ref_key === 'layout' && row.root_hash)
      payload = JSON.stringify({ revision: row.root_hash });
    if (!payload) continue;
    try {
      await put(key, payload);
    } catch (error) {
      await db
        .prepare(
          'UPDATE catalog_ref_state SET delivery_retry_at = ?, delivery_failure = ?, updated_at = ? WHERE ref_key = ? AND committed_seq = ?'
        )
        .bind(
          new Date(Date.now() + 5 * 60_000).toISOString(),
          error instanceof Error ? error.message.slice(0, 200) : 'delivery failed',
          now(),
          row.ref_key,
          row.committed_seq
        )
        .run()
        .catch(() => undefined);
      continue;
    }
    await db
      .prepare(
        'UPDATE catalog_ref_state SET delivered_seq = ?, pending_payload = NULL, delivery_failure = NULL, delivery_retry_at = NULL, last_write_at = ?, updated_at = ? WHERE ref_key = ? AND committed_seq = ?'
      )
      .bind(row.committed_seq, now(), now(), row.ref_key, row.committed_seq)
      .run();
    repaired++;
  }
  return repaired;
}

export type CatalogBuildResult = {
  products: number;
  cardsChanged: number;
  docsChanged: number;
  pages: number;
  kvPuts: number;
};

export type CatalogBuildStep = {
  done: boolean;
  buildId: string;
  phase: string;
  opsUsed: number;
  generation?: number;
  result?: CatalogBuildResult;
  retryAfterSeconds?: number;
};

// Checkpoint JSON holds bounded cursors and counters only. Listing,
// page, root and delivery progress lives in catalog_build_listings,
// catalog_build_pages and catalog_ref_state rows — never in
// catalog-sized arrays inside state_json.
type BuildState = {
  cardsCursor: string;
  products: number;
  cardsChanged: number;
  docsChanged: number;
  kvPuts: number;
  li: number;
  memCursorC: string;
  memCursorI: string;
  memPos: number;
  memStarted: boolean;
  generation: number;
  nextPage: number;
  pageCount: number;
  total: number;
  pagesTotal: number;
  layoutDone: boolean;
  layoutChanged: boolean;
  layoutRevision: string;
  seq: number;
  editorialCursor: string;
  editorialKind: number;
  indexKind: number;
  workCursor: string;
};

function freshBuildState(): BuildState {
  return {
    cardsCursor: '',
    products: 0,
    cardsChanged: 0,
    docsChanged: 0,
    kvPuts: 0,
    li: 0,
    memCursorC: '',
    memCursorI: '',
    memPos: 0,
    memStarted: false,
    generation: 0,
    nextPage: 1,
    pageCount: 1,
    total: 0,
    pagesTotal: 0,
    layoutDone: false,
    layoutChanged: false,
    layoutRevision: '',
    seq: 0,
    editorialCursor: '',
    editorialKind: 0,
    indexKind: 0,
    workCursor: '',
  };
}

type BuildListingRow = {
  id: string;
  pageSize: number;
  kind: string;
  ruleJson: string | null;
  generation: number | null;
  rootHash: string | null;
  changed: number | null;
  pageCount: number | null;
  total: number | null;
};

/** Row-based per-listing build progress (insertion order: the 'all'
 *  listing first, then collections). */
async function loadBuildListings(
  db: D1Database,
  buildId: string,
  offset?: number
): Promise<BuildListingRow[]> {
  const rows = await db
    .prepare(
      `SELECT bl.listing_id, bl.generation, bl.root_hash, bl.changed, bl.page_count, bl.total,
              CASE WHEN bl.listing_id = ? THEN 'all' ELSE c.kind END AS kind, c.rule_json
       FROM catalog_build_listings bl LEFT JOIN collections c ON c.id = bl.listing_id
       WHERE bl.build_id = ? ORDER BY bl.listing_id ${offset == null ? '' : 'LIMIT 1 OFFSET ?'}`
    )
    .bind(ALL_LISTING, buildId, ...(offset == null ? [] : [offset]))
    .all<{
      listing_id: string;
      generation: number | null;
      root_hash: string | null;
      changed: number | null;
      page_count: number | null;
      total: number | null;
      kind: string | null;
      rule_json: string | null;
    }>();
  return rows.results.map((r) => ({
    id: r.listing_id,
    pageSize: r.listing_id === ALL_LISTING ? HOME_PAGE_SIZE : COLLECTION_PAGE_SIZE,
    kind: r.kind ?? 'manual',
    ruleJson: r.rule_json,
    generation: r.generation,
    rootHash: r.root_hash,
    changed: r.changed,
    pageCount: r.page_count,
    total: r.total,
  }));
}

const DEFAULT_BUILD_BUDGET = 900;

async function captureBuildWork(
  db: D1Database,
  buildId: string,
  type: string,
  ids: string[],
  viaProducts = false
): Promise<void> {
  if (!ids.length) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO catalog_builds(id,kind,state,phase,state_json,parent_id,scope_listing_id,source_revision,created_at,updated_at) SELECT 'capture:'||?||':'||id,'capture','captured','capture','{}',?,id,target_revision,?,? FROM catalog_work WHERE processed_revision<target_revision AND entity_type=? AND entity_id IN (${viaProducts ? 'SELECT media_id FROM product_media WHERE product_id IN (SELECT value FROM json_each(?))' : 'SELECT value FROM json_each(?)'})`
    )
    .bind(buildId, buildId, now(), now(), type, JSON.stringify(ids))
    .run();
}

/** One bounded, checkpointed publication unit. Every invocation
 *  performs at most `maxOps` counted D1/KV operations (an application
 *  safety budget; each platform limit is enforced independently —
 *  the KV stub in the scale gate hard-fails past 1,000 KV ops in one
 *  unit), at most ~5,000 source rows and ~8 MB of materialized page
 *  payloads, then persists its cursors in catalog_builds and returns.
 *  Re-running is safe: all writes are content-addressed or guarded,
 *  and D1 revision state advances only after the matching KV writes
 *  land (write-then-advance). Serialized publication: a build row is
 *  claimed by state, and the activation commit's sequence guard
 *  aborts a stale publisher before it can move D1 committed state;
 *  late KV writes from a stale worker are repaired from committed
 *  history rather than adopted. */
export async function processCatalogBuild(
  db: D1Database,
  kv: KvLike | undefined,
  opts: {
    budget: CatalogBudget;
    maxOps?: number;
    kind?: 'full' | 'repair';
    lease?: CatalogLease;
    scopeListingId?: string;
    parentId?: string;
  }
): Promise<CatalogBuildStep> {
  const maxOps = opts.maxOps ?? DEFAULT_BUILD_BUDGET;
  const { budget } = opts;
  let ops = 0;
  const tick = (n = 1, countBudget = true) => {
    ops += n;
    if (countBudget) budget.tickOp(n);
  };

  let build = await db
    .prepare(
      "SELECT id, kind, state, phase, state_json, scope_listing_id FROM catalog_builds WHERE state IN ('building', 'pending_delivery') AND kind NOT IN ('fanout','replica','index') ORDER BY created_at ASC LIMIT 1"
    )
    .first<{
      id: string;
      kind: string;
      state: string;
      phase: string;
      state_json: string;
      scope_listing_id: string | null;
    }>();
  tick();
  if (!build) {
    const id = crypto.randomUUID();
    const at = now();
    const scoped = opts.scopeListingId ?? null;
    // Capture the source-work revision this build represents; work
    // landing after this point stays due for a later pass.
    const revRow = await db
      .prepare('SELECT COALESCE(MAX(target_revision), 0) AS rev FROM catalog_work')
      .first<{ rev: number }>();
    tick();
    await db
      .prepare(
        "INSERT INTO catalog_builds (id, kind, state, phase, state_json, parent_id, scope_listing_id, source_revision, created_at, updated_at) VALUES (?, ?, 'building', ?, '{}', ?, ?, ?, ?, ?)"
      )
      .bind(
        id,
        scoped ? 'listing' : (opts.kind ?? 'full'),
        scoped ? 'memberships' : 'cards',
        opts.parentId ?? null,
        scoped,
        revRow?.rev ?? 0,
        at,
        at
      )
      .run();
    tick();
    if (scoped) {
      await db
        .prepare('INSERT INTO catalog_build_listings (build_id, listing_id) VALUES (?, ?)')
        .bind(id, scoped)
        .run();
      tick();
    }
    build = {
      id,
      kind: scoped ? 'listing' : (opts.kind ?? 'full'),
      state: 'building',
      phase: scoped ? 'memberships' : 'cards',
      state_json: scoped ? JSON.stringify({ ...freshBuildState(), layoutDone: true }) : '{}',
      scope_listing_id: scoped,
    };
  }
  const kind = (['repair', 'source-rebuild'].includes(build.kind) ? 'repair' : 'full') as
    'full' | 'repair';
  const state: BuildState = {
    ...freshBuildState(),
    ...(JSON.parse(build.state_json) as Partial<BuildState>),
  };
  let phase = build.phase;
  let listingsCache: BuildListingRow[] | null = null;
  let cachedListingIndex = -1;
  const buildListings = async (): Promise<BuildListingRow[]> => {
    if (cachedListingIndex !== state.li || !listingsCache) {
      listingsCache = await loadBuildListings(db, build!.id, state.li);
      cachedListingIndex = state.li;
    }
    return listingsCache;
  };
  const patchListingRow = (id: string, patch: Partial<BuildListingRow>): void => {
    const row = listingsCache?.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
  };

  const put: PutFn = async (key, value) => {
    // One external operation: count it once against the KV ceiling
    // (not again as a generic tick) or the slice budget halves.
    tick(1, false);

    state.kvPuts++;
    if (!kv) return;
    await kv.put(key, value);
  };
  const save = async () => {
    await db
      .prepare('UPDATE catalog_builds SET phase = ?, state_json = ?, updated_at = ? WHERE id = ?')
      .bind(phase, JSON.stringify(state), now(), build!.id)
      .run();
  };
  const finish = async (): Promise<CatalogBuildStep> => {
    await db
      .prepare(
        "UPDATE catalog_builds SET state = 'done', phase = 'done', state_json = ?, updated_at = ? WHERE id = ?"
      )
      .bind(JSON.stringify(state), now(), build!.id)
      .run();
    return {
      done: true,
      buildId: build!.id,
      phase: 'done',
      opsUsed: ops,
      result: {
        products: state.products,
        cardsChanged: state.cardsChanged,
        docsChanged: state.docsChanged,
        pages: state.pagesTotal,
        kvPuts: state.kvPuts,
      },
    };
  };

  try {
    while (true) {
      // Shared invocation budget (Round 2): when the caller's budget
      // is nearly spent, checkpoint and let a continuation resume.
      if (ops > 0 && (budget.spent() || !budget.fits(BUILD_STEP_STATEMENTS))) {
        await save();
        return { done: false, buildId: build!.id, phase, opsUsed: ops };
      }
      // A started chunk finishes, so stop early enough that one
      // chunk (<= ~8 counted ops outside the cards phase, which
      // guards its own large batches) cannot overshoot the budget.
      if (ops > 0 && ops + Math.max(4, Math.min(32, Math.floor(maxOps / 10))) > maxOps) {
        await save();
        return { done: false, buildId: build!.id, phase, opsUsed: ops };
      }
      if (build.state === 'pending_delivery' || phase === 'deliver') {
        phase = 'deliver';
        if (!kv) {
          // No KV configured: nothing to deliver to. Confirm the
          // pending payloads as delivered so builds can finish.
          await db
            .prepare(
              'UPDATE catalog_ref_state SET delivered_seq = committed_seq, pending_payload = NULL WHERE pending_payload IS NOT NULL'
            )
            .run();
          tick();
          build.state = 'building';
          phase = 'acknowledge';
          await db
            .prepare(
              "UPDATE catalog_builds SET state='building',phase='acknowledge',state_json=? WHERE id=?"
            )
            .bind(JSON.stringify(state), build.id)
            .run();
          continue;
        }
        // Deliveries are durable catalog_ref_state pending payloads,
        // not checkpoint arrays: deliver a bounded slice, then finish
        // only when nothing this build committed is pending. A key
        // written within the KV pacing window stays pending, so the
        // build waits for it; a key in failure backoff does not block.
        const delivered = await repairPendingDeliveries(db, kv, put, { limit: 4, budget });
        tick();
        const remaining = await db
          .prepare(
            'SELECT COUNT(*) AS n FROM catalog_ref_state WHERE pending_payload IS NOT NULL AND committed_seq <= ? AND (delivery_retry_at IS NULL OR delivery_retry_at <= ?)'
          )
          .bind(state.seq, now())
          .first<{ n: number }>();
        tick();
        if ((remaining?.n ?? 0) === 0) {
          build.state = 'building';
          phase = 'acknowledge';
          await db
            .prepare(
              "UPDATE catalog_builds SET state='building',phase='acknowledge',state_json=? WHERE id=?"
            )
            .bind(JSON.stringify(state), build.id)
            .run();
          continue;
        }
        await save();
        return {
          done: false,
          buildId: build!.id,
          phase,
          opsUsed: ops,
          ...(delivered === 0 ? { retryAfterSeconds: DELIVERY_RETRY_SECONDS } : {}),
        };
      }

      if (phase === 'acknowledge') {
        const prefix = `capture:${build.id}:`;
        const captured = await db
          .prepare(
            "SELECT id,scope_listing_id,source_revision FROM catalog_builds WHERE id>? AND id<? AND state='captured' ORDER BY id LIMIT 128"
          )
          .bind(state.workCursor || prefix, prefix + '~')
          .all<{ id: string; scope_listing_id: string; source_revision: number }>();
        if (!captured.results.length) return await finish();
        const payload = JSON.stringify(captured.results);
        state.workCursor = captured.results.at(-1)!.id;
        await db.batch([
          db
            .prepare(
              "UPDATE catalog_work SET processed_revision=MAX(processed_revision,(SELECT json_extract(value,'$.source_revision') FROM json_each(?) WHERE json_extract(value,'$.scope_listing_id')=catalog_work.id)) WHERE id IN (SELECT json_extract(value,'$.scope_listing_id') FROM json_each(?))"
            )
            .bind(payload, payload),
          db
            .prepare(
              "UPDATE catalog_builds SET state='acknowledged' WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?))"
            )
            .bind(payload),
          db
            .prepare('UPDATE catalog_builds SET state_json=? WHERE id=?')
            .bind(JSON.stringify(state), build.id),
        ]);
        return { done: false, buildId: build.id, phase, opsUsed: ops };
      }

      if (phase === 'discover') {
        const rows = await db
          .prepare('SELECT id FROM collections WHERE id>? ORDER BY id LIMIT 100')
          .bind(state.memCursorI)
          .all<{ id: string }>();
        if (rows.results.length) {
          await captureBuildWork(
            db,
            build.id,
            'collection',
            rows.results.map((r) => r.id)
          );
          await db
            .prepare(
              'INSERT OR IGNORE INTO catalog_build_listings(build_id,listing_id) SELECT ?,value FROM json_each(?)'
            )
            .bind(build.id, JSON.stringify(rows.results.map((r) => r.id)))
            .run();
          state.memCursorI = rows.results.at(-1)!.id;
        } else {
          phase = 'memberships';
          state.memCursorI = '';
        }
        await save();
        return { done: false, buildId: build.id, phase, opsUsed: ops };
      }
      if (phase === 'cards') {
        const rows = await db
          .prepare(
            "SELECT id,length(CAST(description AS BLOB))+length(CAST(title AS BLOB)) AS product_bytes,(SELECT COUNT(*) FROM variants v WHERE v.product_id=products.id) AS variant_rows,(SELECT COUNT(*) FROM product_media pm WHERE pm.product_id=products.id) AS media_rows FROM products WHERE status = 'active' AND id > ? ORDER BY id ASC LIMIT 160"
          )
          .bind(state.cardsCursor)
          .all<{ id: string; variant_rows: number; media_rows: number; product_bytes: number }>();
        tick();
        if (!rows.results.length) {
          // Retire cards for products no longer active (one statement).
          const retired = await db
            .prepare(
              "DELETE FROM catalog_cards WHERE product_id IN (SELECT product_id FROM catalog_cards WHERE product_id NOT IN (SELECT id FROM products WHERE status = 'active') LIMIT 128)"
            )
            .run();
          tick();
          if ((retired.meta.changes ?? 0) === 128) {
            await save();
            return { done: false, buildId: build.id, phase, opsUsed: ops };
          }
          await db
            .prepare(
              'INSERT OR IGNORE INTO catalog_build_listings(build_id,listing_id) VALUES(?,?)'
            )
            .bind(build.id, ALL_LISTING)
            .run();
          phase = 'discover';
          state.memCursorI = '';
          await save();
          continue;
        }
        const ids: string[] = [];
        let sourceRows = 0,
          materialBytes = 0;
        for (const row of rows.results) {
          const cost = 3 + row.variant_rows + row.media_rows;
          if (cost > 3500) throw new Error('Product exceeds bounded publication source size');
          const bytes = 6 * (row.product_bytes + 1024 + 2048 * (row.variant_rows + row.media_rows));
          if (ids.length && (sourceRows + cost > 3500 || materialBytes + bytes > 2 * 1024 * 1024))
            break;
          ids.push(row.id);
          sourceRows += cost;
          materialBytes += bytes;
        }
        if (ops > 0 && ops + ids.length * 3 + 8 > maxOps) {
          await save();
          return { done: false, buildId: build!.id, phase, opsUsed: ops };
        }
        const docMirrors: { key: string; revision: string; payload: string }[] = [];
        const renamedScopes: { scope: string; scopeId: string }[] = [];
        await captureBuildWork(db, build.id, 'product', ids);
        await captureBuildWork(db, build.id, 'media', ids, true);
        const cardRows = await listPublishedProductsByIds(db, ids);
        tick(Math.ceil(ids.length / 90));
        const cardsById = new Map(cardRows.map((c) => [c.id, c as CatalogCard]));
        const docs = await buildProductDocuments(db, ids, budget);
        tick(Math.ceil(ids.length / 90) * 3);
        const existingById = new Map<
          string,
          { product_id: string; slug: string; revision: string; doc_revision: string }
        >();
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunk = ids.slice(i, i + CHUNK);
          const existing = await db
            .prepare(
              `SELECT product_id, slug, revision, doc_revision FROM catalog_cards WHERE product_id IN (${placeholders(chunk.length)})`
            )
            .bind(...chunk)
            .all<{ product_id: string; slug: string; revision: string; doc_revision: string }>();
          tick();
          for (const r of existing.results) existingById.set(r.product_id, r);
        }
        const at = now();
        const changedRows: {
          productId: string;
          slug: string;
          cardJson: string;
          revision: string;
          docRevision: string;
        }[] = [];
        for (const id of ids) {
          const card = cardsById.get(id);
          if (!card) continue;
          state.products++;
          const cardJson = JSON.stringify(card);
          const cardRev = contentRevision(cardJson);
          const doc = docs.get(id);
          const prev = existingById.get(id);
          if (
            kind !== 'repair' &&
            prev?.revision === cardRev &&
            (!doc || prev?.doc_revision === doc.revision)
          )
            continue;
          if (prev && prev.slug !== card.slug) {
            renamedScopes.push(
              { scope: 'product', scopeId: prev.slug },
              { scope: 'product', scopeId: card.slug }
            );
          }
          // Write-then-advance: KV document + slug pointer land
          // before the D1 revision columns move. Repair re-puts even
          // when D1 revisions already match (KV may have lost them).
          if (doc && (prev?.doc_revision !== doc.revision || kind === 'repair')) {
            const docJson = JSON.stringify(doc);
            await put(productDocKey(id, doc.revision), docJson);
            await put(productSlugKey(card.slug), JSON.stringify({ id, revision: doc.revision }));
            docMirrors.push({
              key: productDocKey(id, doc.revision),
              revision: doc.revision,
              payload: docJson,
            });
            if (prev?.doc_revision !== doc.revision) state.docsChanged++;
          }
          if (prev && prev.slug !== card.slug) {
            await publishMoves(db, put, 'products', card.slug, prev.slug);
            tick();
          }
          if (prev?.revision !== cardRev) state.cardsChanged++;
          if (prev?.revision !== cardRev || (doc && prev?.doc_revision !== doc.revision))
            changedRows.push({
              productId: id,
              slug: card.slug,
              cardJson,
              revision: cardRev,
              docRevision: doc?.revision ?? '',
            });
        }
        await recordInvalidations(db, renamedScopes);
        // D1 document mirrors (bulk, one statement per chunk).
        for (let i = 0; i < docMirrors.length; i += 60) {
          const slice = docMirrors.slice(i, i + 60);
          await db
            .prepare(
              `INSERT INTO catalog_documents (key, kind, revision, payload_json, updated_at)
               SELECT json_extract(value, '$.key'), 'product', json_extract(value, '$.revision'), json_extract(value, '$.payload'), ? FROM json_each(?) WHERE true
               ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json, updated_at = excluded.updated_at`
            )
            .bind(at, JSON.stringify(slice))
            .run();
          tick();
        }
        if (changedRows.length) {
          if (ops > 0 && ops + changedRows.length > maxOps) {
            await save();
            return { done: false, buildId: build!.id, phase, opsUsed: ops };
          }
          // Bulk upsert: one statement per 100 rows via json_each,
          // not one statement per product.
          for (let i = 0; i < changedRows.length; i += 100) {
            await db
              .prepare(
                `INSERT INTO catalog_cards (product_id, slug, card_json, revision, doc_revision, published_revision, updated_at)
                 SELECT json_extract(value, '$.productId'), json_extract(value, '$.slug'), json_extract(value, '$.cardJson'), json_extract(value, '$.revision'), json_extract(value, '$.docRevision'), json_extract(value, '$.revision'), ? FROM json_each(?) WHERE true
                 ON CONFLICT(product_id) DO UPDATE SET slug = excluded.slug, card_json = excluded.card_json, revision = excluded.revision, doc_revision = excluded.doc_revision, published_revision = excluded.published_revision, updated_at = excluded.updated_at`
              )
              .bind(at, JSON.stringify(changedRows.slice(i, i + 100)))
              .run();
            tick();
          }
          tick(changedRows.length);
        }

        state.cardsCursor = ids[ids.length - 1]!;
        await save();
        continue;
      }

      if (phase === 'memberships') {
        const listing = (await buildListings())[0];
        if (!listing) {
          phase = 'pages';
          state.li = 0;
          state.generation = 0;
          await save();
          continue;
        }
        if (!state.memStarted) {
          await db
            .prepare('DELETE FROM catalog_membership WHERE listing_id = ?')
            .bind(listing.id)
            .run();
          tick();
          state.memStarted = true;
          state.memCursorC = '';
          state.memCursorI = '';
          state.memPos = 0;
        }
        const rows = await db
          .prepare(
            `SELECT id, created_at FROM products WHERE status = 'active'
             AND (? = '' OR created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC LIMIT 500`
          )
          .bind(state.memCursorC, state.memCursorC, state.memCursorC, state.memCursorI)
          .all<{ id: string; created_at: string }>();
        tick();
        if (!rows.results.length) {
          state.li++;
          state.memStarted = false;
          await save();
          continue;
        }
        const ids = rows.results.map((r) => r.id);
        const cardsById = new Map<string, CatalogCard>();
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunk = ids.slice(i, i + CHUNK);
          const cardRows = await db
            .prepare(
              `SELECT product_id, card_json FROM catalog_cards WHERE product_id IN (${placeholders(chunk.length)})`
            )
            .bind(...chunk)
            .all<{ product_id: string; card_json: string }>();
          tick();
          for (const r of cardRows.results)
            cardsById.set(r.product_id, JSON.parse(r.card_json) as CatalogCard);
        }
        let memberIds: string[] = [];
        if (listing.kind === 'all') memberIds = ids;
        else if (listing.kind === 'rule') {
          const rule = parseRule(listing.ruleJson);
          if (rule)
            memberIds = ids.filter((id) => {
              const c = cardsById.get(id);
              if (!c) return false;
              if (rule.type === 'title_contains') return c.title.includes(rule.value);
              if (c.priceCents == null) return false;
              return rule.type === 'price_lte'
                ? c.priceCents <= rule.value
                : c.priceCents >= rule.value;
            });
        } else {
          const set = new Set<string>();
          for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            const manual = await db
              .prepare(
                `SELECT product_id FROM product_collections WHERE collection_id = ? AND product_id IN (${placeholders(chunk.length)})`
              )
              .bind(listing.id, ...chunk)
              .all<{ product_id: string }>();
            tick();
            for (const r of manual.results) set.add(r.product_id);
          }
          memberIds = ids.filter((id) => set.has(id));
        }
        if (memberIds.length) {
          const entries = memberIds.map((id, j) => ({ id, pos: state.memPos + j }));
          await db
            .prepare(
              `INSERT OR IGNORE INTO catalog_membership (listing_id, product_id, position)
               SELECT ?, json_extract(value, '$.id'), CAST(json_extract(value, '$.pos') AS INTEGER) FROM json_each(?)`
            )
            .bind(listing.id, JSON.stringify(entries))
            .run();
          tick();
          state.memPos += memberIds.length;
        }
        const lastRow = rows.results[rows.results.length - 1]!;
        state.memCursorC = lastRow.created_at;
        state.memCursorI = lastRow.id;
        await save();
        continue;
      }

      if (phase === 'pages') {
        const listing = (await buildListings())[0];
        if (!listing) {
          phase = 'directory';
          state.li = 0;
          await save();
          continue;
        }
        if (!state.generation) {
          const totalRow = await db
            .prepare('SELECT COUNT(*) AS n FROM catalog_membership WHERE listing_id = ?')
            .bind(listing.id)
            .first<{ n: number }>();
          tick();
          state.total = totalRow?.n ?? 0;
          state.pageCount = Math.max(1, Math.ceil(state.total / listing.pageSize));
          const active = await db
            .prepare('SELECT generation FROM catalog_listings WHERE listing_id = ? AND active = 1')
            .bind(listing.id)
            .first<{ generation: number }>();
          tick();
          state.generation = (active?.generation ?? 0) + 1;
          state.nextPage = 1;
          await db
            .prepare(
              'UPDATE catalog_build_listings SET generation = ?, page_count = ?, total = ? WHERE build_id = ? AND listing_id = ?'
            )
            .bind(state.generation, state.pageCount, state.total, build.id, listing.id)
            .run();
          patchListingRow(listing.id, {
            generation: state.generation,
            pageCount: state.pageCount,
            total: state.total,
          });
          tick();
          const at = now();
          await db.batch([
            db
              .prepare(
                `INSERT INTO catalog_listings (listing_id, generation, page_size, page_count, total, active, state, updated_at) VALUES (?, ?, ?, ?, ?, 0, 'building', ?)
                 ON CONFLICT(listing_id, generation) DO UPDATE SET page_size = excluded.page_size, page_count = excluded.page_count, total = excluded.total, state = 'building', updated_at = excluded.updated_at`
              )
              .bind(
                listing.id,
                state.generation,
                listing.pageSize,
                state.pageCount,
                state.total,
                at
              ),
            db
              .prepare(
                'DELETE FROM catalog_listing_page_revisions WHERE listing_id = ? AND generation = ?'
              )
              .bind(listing.id, state.generation),
            db
              .prepare('DELETE FROM catalog_page_products WHERE listing_id = ? AND generation = ?')
              .bind(listing.id, state.generation),
          ]);
          tick(3);
          await save();
          continue;
        }
        if (state.nextPage > state.pageCount) {
          state.pagesTotal += state.pageCount;
          state.li++;
          state.generation = 0;
          await save();
          continue;
        }
        // Process pages in groups: one membership slice and one
        // card fetch per group, one D1 batch for the whole group —
        // still one durable page revision per page.
        let groupSize = Math.min(8, state.pageCount - state.nextPage + 1);
        // Reserve the complete group before writing KV: membership +
        // active revisions + card chunks, three mutations per page,
        // the batch fence and the fenced checkpoint, keeping the
        // finish reserve available for checkpoint/release handling.
        const groupStatements = (pages: number) =>
          5 + Math.ceil((pages * listing.pageSize) / CHUNK) + 3 * pages;
        while (groupSize > 0 && !budget.fits(groupStatements(groupSize))) groupSize--;
        if (groupSize === 0) {
          await save();
          return { done: false, buildId: build.id, phase, opsUsed: ops };
        }
        const groupPages: number[] = [];
        for (let g = 0; g < groupSize; g++) groupPages.push(state.nextPage + g);
        const fromPos = (groupPages[0]! - 1) * listing.pageSize;
        const toPos = fromPos + groupPages.length * listing.pageSize;
        const members = await db
          .prepare(
            'SELECT product_id, position FROM catalog_membership WHERE listing_id = ? AND position >= ? AND position < ? ORDER BY position'
          )
          .bind(listing.id, fromPos, toPos)
          .all<{ product_id: string; position: number }>();
        tick();
        const byId = new Map<string, CatalogCard>();
        const memberIds = members.results.map((r) => r.product_id);
        for (let i = 0; i < memberIds.length; i += CHUNK) {
          const chunk = memberIds.slice(i, i + CHUNK);
          const cardRows = await db
            .prepare(
              `SELECT product_id, card_json FROM catalog_cards WHERE product_id IN (${placeholders(chunk.length)})`
            )
            .bind(...chunk)
            .all<{ product_id: string; card_json: string }>();
          tick();
          for (const r of cardRows.results)
            byId.set(r.product_id, JSON.parse(r.card_json) as CatalogCard);
        }
        // Active generation's revisions for this page range (no-op
        // skip), in one query.
        const activeRevs = new Map<number, string>();
        if (kind !== 'repair') {
          const rows = await db
            .prepare(
              `SELECT page, revision FROM catalog_listing_page_revisions
               WHERE listing_id = ? AND generation = ? AND page >= ? AND page <= ?`
            )
            .bind(
              listing.id,
              state.generation - 1,
              groupPages[0]!,
              groupPages[groupPages.length - 1]!
            )
            .all<{ page: number; revision: string }>();
          tick();
          for (const r of rows.results) activeRevs.set(r.page, r.revision);
        }
        const idsByPage = new Map<number, string[]>();
        for (const m of members.results) {
          const pg = Math.floor(m.position / listing.pageSize) + 1;
          (idsByPage.get(pg) ?? idsByPage.set(pg, []).get(pg)!).push(m.product_id);
        }
        const at = now();
        const stmts: D1PreparedStatement[] = [];
        for (const page of groupPages) {
          const pageIds = idsByPage.get(page) ?? [];
          const pageCards = pageIds
            .map((id) => byId.get(id))
            .filter((c): c is CatalogCard => Boolean(c));
          const payload: ListingPage = {
            listingId: listing.id,
            generation: state.generation,
            page,
            pageSize: listing.pageSize,
            total: state.total,
            pageCount: state.pageCount,
            cards: pageCards,
          };
          const revision = listingPageRevision(payload);
          if (kind === 'repair' || activeRevs.get(page) !== revision)
            await put(listingPageKey(listing.id, page, revision), serializeListingPage(payload));
          stmts.push(
            db
              .prepare(
                `INSERT INTO catalog_listing_page_revisions (listing_id, generation, page, revision, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(listing_id, generation, page, revision) DO NOTHING`
              )
              .bind(listing.id, state.generation, page, revision, serializeListingPage(payload), at)
          );
          if (pageIds.length)
            stmts.push(
              db
                .prepare(
                  `INSERT OR IGNORE INTO catalog_page_products (product_id, listing_id, generation, page)
                   SELECT json_extract(value, '$.pid'), ?, ?, CAST(json_extract(value, '$.page') AS INTEGER) FROM json_each(?)`
                )
                .bind(
                  listing.id,
                  state.generation,
                  JSON.stringify(pageIds.map((pid) => ({ pid, page })))
                )
            );
          stmts.push(
            db
              .prepare(
                'INSERT OR REPLACE INTO catalog_build_pages (build_id, listing_id, page, revision) VALUES (?, ?, ?, ?)'
              )
              .bind(build.id, listing.id, page, revision)
          );
        }
        if (stmts.length) {
          await db.batch(stmts);
          tick(stmts.length);
        }
        state.nextPage += groupPages.length;
        await save();
        continue;
      }

      if (phase === 'directory') {
        const listing = (await buildListings())[0];
        if (!listing) {
          phase = 'layout';
          await save();
          continue;
        }
        // Recompute this listing's page revisions from its staged rows.
        const revs = await db
          .prepare(
            'SELECT page, revision FROM catalog_listing_page_revisions WHERE listing_id = ? AND generation = ? ORDER BY page'
          )
          .bind(listing.id, listing.generation ?? 0)
          .all<{ page: number; revision: string }>();
        tick();
        const estNodes =
          Math.ceil(revs.results.length / DIRECTORY_FANOUT) +
          Math.ceil(revs.results.length / (DIRECTORY_FANOUT * DIRECTORY_FANOUT)) +
          2;
        if (ops > 0 && ops + estNodes + 4 > maxOps) {
          await save();
          return { done: false, buildId: build!.id, phase, opsUsed: ops };
        }
        const rootHash = await buildDirectory(
          db,
          kv,
          put,
          listing.id,
          revs.results,
          kind === 'repair'
        );
        const refState = await db
          .prepare('SELECT root_hash FROM catalog_ref_state WHERE ref_key = ?')
          .bind(`listing:${listing.id}`)
          .first<{ root_hash: string | null }>();
        tick();
        let changed = refState?.root_hash !== rootHash;
        if (!changed && kind === 'repair' && kv) {
          tick();
          changed = (await kv.get(listingRefKey(listing.id)).catch(() => null)) == null;
        }
        await db
          .prepare(
            'UPDATE catalog_build_listings SET root_hash = ?, changed = ? WHERE build_id = ? AND listing_id = ?'
          )
          .bind(rootHash, changed ? 1 : 0, build.id, listing.id)
          .run();
        patchListingRow(listing.id, { rootHash, changed: changed ? 1 : 0 });
        tick();
        state.li++;
        await save();
        continue;
      }

      if (phase === 'layout') {
        if (state.layoutDone) {
          // Scoped listing build: layout is not its concern.
          phase = 'activate';
          await save();
          continue;
        }
        tick();
        await captureBuildWork(db, build.id, 'settings', ['store']);
        const settings = await getSettings(db);
        tick();
        const layout = await buildLayoutModel(db, settings);
        tick();
        const layoutRev = contentRevision(JSON.stringify({ ...layout, revision: '' }));
        state.layoutRevision = layoutRev;
        const prevLayoutRef = kv ? await kv.get(LAYOUT_REF_KEY).catch(() => null) : null;
        tick();
        state.layoutChanged = !prevLayoutRef || !prevLayoutRef.includes(layoutRev);
        if (state.layoutChanged) {
          const layoutJson = JSON.stringify({ ...layout, revision: layoutRev });
          await put(layoutKey(layoutRev), layoutJson);
          await mirrorDocument(db, 'layout', layoutKey(layoutRev), layoutRev, layoutJson);
          tick();
        }
        if (state.editorialKind < 3) {
          const table =
            state.editorialKind === 0
              ? 'posts'
              : state.editorialKind === 1
                ? 'pages'
                : 'collections';
          const entityType = table === 'posts' ? 'post' : table === 'pages' ? 'page' : 'collection';
          const fields =
            table === 'posts'
              ? `id,slug,title,excerpt,content_html,seo_title,seo_description,published_at,status,${POST_METADATA_FIELDS}`
              : table === 'pages'
                ? 'id,slug,title,content_html,seo_title,seo_description'
                : 'id,slug,title,description,seo_title,seo_description,kind,rule_json';
          const row = await db
            .prepare(
              `SELECT ${fields},(SELECT target_revision FROM catalog_work WHERE entity_type=? AND entity_id=source.id) AS captured_work_revision FROM ${table} source WHERE id>? ORDER BY id LIMIT 1`
            )
            .bind(entityType, state.editorialCursor)
            .first<Record<string, unknown>>();
          if (row) {
            const eligible =
              table !== 'posts' ||
              (row.status === 'published' &&
                (row.published_at == null || String(row.published_at) <= now())) ||
              (row.status === 'scheduled' && String(row.published_at) <= now());
            if (eligible) {
              if (row.captured_work_revision != null)
                await db
                  .prepare(
                    "INSERT OR IGNORE INTO catalog_builds(id,kind,state,phase,state_json,parent_id,scope_listing_id,source_revision,created_at,updated_at) VALUES(?,'capture','captured','capture','{}',?,?,?,?,?)"
                  )
                  .bind(
                    `capture:${build.id}:${entityType}:${row.id}`,
                    build.id,
                    `${entityType}:${row.id}`,
                    Number(row.captured_work_revision),
                    now(),
                    now()
                  )
                  .run();
              const key =
                table === 'collections'
                  ? collectionMetaKey(String(row.slug))
                  : editorialKey(table === 'posts' ? 'post' : 'page', String(row.slug));
              const value = JSON.stringify(
                table === 'collections'
                  ? {
                      id: row.id,
                      slug: row.slug,
                      title: row.title,
                      description: row.description,
                      seoTitle: row.seo_title,
                      seoDescription: row.seo_description,
                      kind: row.kind,
                      ruleJson: row.rule_json,
                    }
                  : {
                      kind: table === 'posts' ? 'post' : 'page',
                      slug: row.slug,
                      title: row.title,
                      excerpt: row.excerpt ?? '',
                      contentHtml: await publishedMediaContent(db, String(row.content_html ?? '')),
                      seoTitle: row.seo_title,
                      seoDescription: row.seo_description,
                      publishedAt: row.published_at ?? null,
                      coverKey: row.cover_key ?? null,
                      coverPublicUrl: row.cover_public_url ?? null,
                      tags: row.tags ?? null,
                      authorName: row.author_name ?? null,
                    }
              );
              await publishDocument(
                db,
                kv,
                put,
                table === 'collections' ? 'collection-meta' : 'editorial',
                key,
                value
              );
            } else {
              await unpublishDocument(db, kv, editorialKey('post', String(row.slug)));
            }
            state.editorialCursor = String(row.id);
          } else {
            state.editorialKind++;
            state.editorialCursor = '';
          }
          await save();
          return { done: false, buildId: build.id, phase, opsUsed: ops };
        }
        state.layoutDone = true;
        phase = 'indexes';
        await save();
        continue;
      }

      if (phase === 'indexes') {
        const listingId = state.indexKind === 0 ? COLLECTION_INDEX : POSTS_INDEX;
        const done = await processPublishedIndex(
          db,
          kv,
          put,
          `index:${build.id}:${listingId}`,
          listingId,
          build.id
        );
        if (done) state.indexKind++;
        if (state.indexKind >= 2) phase = 'activate';
        await save();
        return { done: false, buildId: build.id, phase, opsUsed: ops };
      }

      if (phase === 'activate') {
        const next = await db
          .prepare(
            `SELECT b.listing_id,COALESCE(col.slug,b.listing_id) AS slug,b.generation,b.root_hash,b.page_count,b.total FROM catalog_build_listings b LEFT JOIN collections col ON col.id=b.listing_id WHERE b.build_id=? AND (b.changed=1 OR (b.changed=0 AND ${metadataChangedSql})) ORDER BY b.listing_id LIMIT 1`
          )
          .bind(build.id)
          .first<{
            listing_id: string;
            slug: string;
            generation: number;
            root_hash: string;
            page_count: number;
            total: number;
          }>();
        if (next) {
          state.seq = await commitListingPublication(
            db,
            {
              listingId: next.listing_id,
              generation: next.generation,
              rootHash: next.root_hash,
              pageSize: next.listing_id === ALL_LISTING ? HOME_PAGE_SIZE : COLLECTION_PAGE_SIZE,
              total: next.total,
              pageCount: next.page_count,
            },
            [
              db
                .prepare(
                  'UPDATE catalog_build_listings SET changed=2 WHERE build_id=? AND listing_id=?'
                )
                .bind(build.id, next.listing_id),
              ...invalidationStatements(db, [
                { scope: 'listing', scopeId: next.slug, listingId: next.listing_id },
              ]),
            ]
          );
          await save();
          return { done: false, buildId: build.id, phase, opsUsed: ops };
        }
        if (state.layoutChanged) {
          const seq =
            (await db
              .prepare('SELECT publication_seq FROM catalog_publication_state WHERE id=1')
              .first<{ publication_seq: number }>())!.publication_seq + 1;
          const payload = JSON.stringify({ revision: state.layoutRevision });
          state.layoutChanged = false;
          state.seq = seq;
          phase = 'deliver';
          await db.batch([
            db
              .prepare(
                'INSERT INTO batch_guard SELECT 1 WHERE (SELECT publication_seq FROM catalog_publication_state WHERE id=1)<>?'
              )
              .bind(seq - 1),
            db
              .prepare('UPDATE catalog_publication_state SET publication_seq=? WHERE id=1')
              .bind(seq),
            db
              .prepare(
                "INSERT INTO catalog_ref_state(ref_key,committed_seq,delivered_seq,root_hash,pending_payload,updated_at) VALUES('layout',?,0,?,?,?) ON CONFLICT(ref_key) DO UPDATE SET committed_seq=excluded.committed_seq,root_hash=excluded.root_hash,pending_payload=excluded.pending_payload"
              )
              .bind(seq, state.layoutRevision, payload, now()),
            db
              .prepare(
                "INSERT OR IGNORE INTO catalog_ref_documents(ref_key,publication_seq,document_key) VALUES('layout',?,?)"
              )
              .bind(seq, layoutKey(state.layoutRevision)),
            db
              .prepare(
                "UPDATE catalog_builds SET phase='deliver',state='pending_delivery',state_json=? WHERE id=?"
              )
              .bind(JSON.stringify(state), build.id),
          ]);
        } else {
          phase = 'deliver';
          await save();
        }
        return { done: false, buildId: build.id, phase, opsUsed: ops };
      }

      return { done: false, buildId: build!.id, phase, opsUsed: ops };
    }
    await save();
    return { done: false, buildId: build!.id, phase, opsUsed: ops };
  } catch (error) {
    if (error instanceof BudgetExhausted) {
      await budget.finalize(save).catch(() => undefined);
      return { done: false, buildId: build.id, phase, opsUsed: ops };
    }
    await budget.finalize(save).catch(() => undefined);
    console.error(
      JSON.stringify({
        event: 'catalog_build_failed',
        buildId: build.id,
        phase,
        error: error instanceof Error ? error.message : 'unknown',
      })
    );
    throw error;
  }
}

/** Failed work retries after 60 s, doubling per attempt up to an hour. */
const WORK_RETRY_BASE_SECONDS = 60;
const WORK_RETRY_MAX_SECONDS = 3_600;

/** Delay before retrying while another invocation holds the catalogue lease. */
export const BUSY_RETRY_SECONDS = 5;
const DELIVERY_RETRY_SECONDS = 2;

const buildUnitResult = (step: CatalogBuildStep) => ({
  done: step.done,
  busy: false,
  ...(step.retryAfterSeconds ? { retryAfterSeconds: step.retryAfterSeconds } : {}),
});

/** One bounded production unit under the shared invocation budget
 *  and the publisher lease (Round 2 execution model). Priority:
 *  continue an open build, deliver pending references, bootstrap or
 *  repair, then one incremental work pass. Returns done=false when
 *  continuation is required; the queue handler enqueues the
 *  continuation before acking. A lost lease is a harmless no-op.
 *  The queue handler may run several units under one budget. */
export async function runCatalogUnit(
  db: D1Database,
  kv: KvLike | undefined,
  opts: { budget: CatalogBudget; nowMs?: number; maintenance?: 'replica' | 'gc' }
): Promise<{
  done: boolean;
  busy: boolean;
  budgetExhausted?: boolean;
  retryAfterSeconds?: number;
}> {
  const { budget } = opts;
  const metered = countedDb(db, budget);
  let cdb = metered;
  kv = kv ? countedKv(kv, budget) : undefined;
  let lease: CatalogLease | null = null;
  try {
    lease = await claimCatalogLease(cdb, opts.nowMs);
  } catch (error) {
    if (error instanceof BudgetExhausted)
      return { done: false, busy: false, budgetExhausted: true };
    throw error;
  }
  if (!lease) return { done: false, busy: true, retryAfterSeconds: BUSY_RETRY_SECONDS };
  cdb = fencedCatalogDb(metered, lease);
  try {
    // Maintenance runs only its own step; catalogue work stays on the catalog.rebuild chain.
    if (opts.maintenance) {
      if (opts.maintenance === 'gc')
        return { done: (await runCatalogGcUnit(metered, kv, lease)) === null, busy: false };
      return { done: kv ? await repairCatalogUnit(cdb, kv, lease) : true, busy: false };
    }
    const open = await cdb
      .prepare(
        "SELECT id,kind,scope_listing_id FROM catalog_builds WHERE state IN ('building', 'pending_delivery') AND kind NOT IN ('fanout') ORDER BY updated_at,id LIMIT 1"
      )
      .first<{ id: string; kind: string; scope_listing_id: string | null }>();
    if (open?.kind === 'index') {
      await processPublishedIndex(
        cdb,
        kv,
        async (key, value) => {
          if (kv) await kv.put(key, value);
        },
        open.id,
        open.scope_listing_id as PublishedIndex,
        null
      );
      return { done: false, busy: false };
    }
    if (open?.kind === 'replica' && kv) {
      const due = await cdb
        .prepare(
          'SELECT 1 FROM catalog_work WHERE processed_revision<target_revision AND (next_attempt_at IS NULL OR next_attempt_at<=?) LIMIT 1'
        )
        .bind(now())
        .first();
      if (!due) return { done: await repairCatalogUnit(cdb, kv, lease), busy: false };
    }
    if (open && open.kind !== 'replica') {
      const step = await processCatalogBuild(cdb, kv, { budget, lease });
      if (step.done) {
        const due = await cdb
          .prepare(
            `SELECT 1 AS pending WHERE EXISTS(SELECT 1 FROM catalog_work WHERE processed_revision<target_revision AND (next_attempt_at IS NULL OR next_attempt_at<=?))
             OR EXISTS(SELECT 1 FROM catalog_builds WHERE state IN ('building','pending_delivery'))
             OR EXISTS(SELECT 1 FROM catalog_ref_state WHERE pending_payload IS NOT NULL AND (delivery_retry_at IS NULL OR delivery_retry_at<=?))`
          )
          .bind(now(), now())
          .first();
        if (due) return { done: false, busy: false };
      }
      return buildUnitResult(step);
    }
    const put: PutFn = async (key, value) => {
      if (kv) await kv.put(key, value);
    };
    const repaired = await repairPendingDeliveries(cdb, kv, put, { limit: 4, budget });
    if (repaired > 0) {
      const stillPending = await cdb
        .prepare('SELECT COUNT(*) AS n FROM catalog_ref_state WHERE pending_payload IS NOT NULL')
        .first<{ n: number }>();
      if ((stillPending?.n ?? 0) > 0) return { done: false, busy: false };
    }
    const active = await cdb
      .prepare('SELECT generation FROM catalog_listings WHERE listing_id = ? AND active = 1')
      .bind(ALL_LISTING)
      .first<{ generation: number }>();
    if (!active) {
      // Bootstrap, or KV-loss repair when D1 holds generations but
      // KV lost the 'all' reference: one bounded build unit either way.
      let kind: 'full' | 'repair' = 'full';
      const anyGen = await cdb
        .prepare('SELECT generation FROM catalog_listings LIMIT 1')
        .first<{ generation: number }>();
      if (anyGen && kv) {
        const refRaw = await kv.get(listingRefKey(ALL_LISTING)).catch(() => null);
        kind = refRaw ? 'full' : 'repair';
      }
      const step = await processCatalogBuild(cdb, kv, { budget, lease, kind });
      return buildUnitResult(step);
    }
    if (kv) {
      const refRaw = await kv.get(listingRefKey(ALL_LISTING)).catch(() => null);
      if (!refRaw) {
        return { done: await repairCatalogUnit(cdb, kv, lease), busy: false };
      }
    }
    const work = await processCatalogWork(cdb, kv, { budget, lease, limit: 1 });
    if (work.processed > 0 || work.more) return { done: false, busy: false };
    const openAfter = await cdb
      .prepare(
        `SELECT 1 WHERE EXISTS(SELECT 1 FROM catalog_builds WHERE state IN ('building','pending_delivery'))
          OR EXISTS(SELECT 1 FROM catalog_ref_state WHERE pending_payload IS NOT NULL AND (delivery_retry_at IS NULL OR delivery_retry_at<=?))`
      )
      .bind(now())
      .first();
    if (!openAfter && kv && budget.remainingStatements >= 20) {
      await verifyChangedReferences(cdb, kv);
      const waiting = await cdb
        .prepare(
          'SELECT MIN(verify_after) AS due FROM catalog_ref_state WHERE verify_after IS NOT NULL'
        )
        .first<{ due: string | null }>();
      if (waiting?.due)
        return {
          done: false,
          busy: false,
          retryAfterSeconds: Math.max(
            1,
            Math.min(60, Math.ceil((Date.parse(waiting.due) - Date.now()) / 1000))
          ),
        };
    }
    return { done: !openAfter, busy: false };
  } catch (error) {
    if (error instanceof BudgetExhausted)
      return { done: false, busy: false, budgetExhausted: true };
    throw error;
  } finally {
    if (lease) await budget.finalize(() => releaseCatalogLease(metered, lease!));
  }
}

/** Deliberate source rebuild, distinct from restoring committed KV replicas. */
export async function requestCatalogSourceRebuild(db: D1Database): Promise<void> {
  await db
    .prepare(
      "INSERT INTO catalog_builds(id,kind,state,phase,state_json,source_revision,created_at,updated_at) SELECT ?,'source-rebuild','building','cards','{}',COALESCE((SELECT MAX(target_revision) FROM catalog_work),0),?,? WHERE NOT EXISTS(SELECT 1 FROM catalog_builds WHERE state IN ('building','pending_delivery') AND kind NOT IN ('fanout','replica'))"
    )
    .bind(crypto.randomUUID(), now(), now())
    .run();
}

async function buildLayoutModel(db: D1Database, settings: Awaited<ReturnType<typeof getSettings>>) {
  // Layout contains a fixed navigation preview, never every collection.
  const navigation = await db
    .prepare('SELECT slug,title,description FROM collections ORDER BY title,id LIMIT 8')
    .all<{ slug: string; title: string; description: string }>();
  const count = await db.prepare('SELECT COUNT(*) AS n FROM collections').first<{ n: number }>();
  const featured = await db
    .prepare(
      'SELECT slug,title FROM collections WHERE featured_rank IS NOT NULL ORDER BY featured_rank,title LIMIT ?'
    )
    .bind(MAX_RAILS)
    .all<{ slug: string; title: string }>();
  const posts = await db
    .prepare(
      "SELECT slug,title,excerpt,published_at FROM posts WHERE (status='published' AND (published_at IS NULL OR published_at<=?)) OR (status='scheduled' AND published_at IS NOT NULL AND published_at<=?) ORDER BY published_at DESC,id DESC LIMIT 3"
    )
    .bind(now(), now())
    .all<{ slug: string; title: string; excerpt: string; published_at: string | null }>();
  return {
    limits: settings.limits as unknown as Record<string, number>,
    storeName: settings.storeName,
    announcementText: settings.announcementText,
    seoTitleTemplate: settings.seoTitleTemplate,
    canonicalBaseUrl: settings.canonicalBaseUrl,
    currency: settings.currency,
    // Nav shows at most 8; the total travels with the model so the
    // storefront can link the rest to the collections index instead
    // of silently discarding them.
    collections: navigation.results.map(({ slug, title }) => ({ slug, title })),
    collectionTeasers: navigation.results.slice(0, 4),
    collectionsTotal: count?.n ?? 0,
    featured: featured.results,
    posts: posts.results.map((p) => ({ ...p, published_at: p.published_at ?? '' })),
  };
}

async function buildProductDocuments(
  db: D1Database,
  orderedIds: string[],
  budget: CatalogBudget
): Promise<Map<string, ProductDocument>> {
  const docs = new Map<string, ProductDocument>();
  // Bounded fast path: an explicit ID set is fetched with IN chunks
  // under the bind limit — never a whole-catalog scan for one page of
  // products. Child rows are bounded in SQL before materialization.
  if (orderedIds.length) {
    type P = {
      id: string;
      slug: string;
      title: string;
      description: string;
      status: ProductDocument['status'];
      seo_title: string | null;
      seo_description: string | null;
    };
    const productById = new Map<string, P>();
    const variantsByProduct = new Map<string, ProductDocument['variants']>();
    const imagesByProduct = new Map<string, ProductDocument['images']>();
    for (let i = 0; i < orderedIds.length; i += CHUNK) {
      const chunk = orderedIds.slice(i, i + CHUNK);
      const ph = placeholders(chunk.length);
      const products = await db
        .prepare(
          `SELECT id, slug, title, description, status, seo_title, seo_description FROM products WHERE status = 'active' AND id IN (${ph})`
        )
        .bind(...chunk)
        .all<P>();
      for (const p of products.results) productById.set(p.id, p);
      if (!products.results.length) continue;
      if (budget.rows >= 5000) throw new BudgetExhausted('rows');
      const variants = await db
        .prepare(
          `SELECT id, product_id, sku, title, price_cents, compare_at_cents, status, continue_selling, weight_grams,COUNT(*) OVER() AS catalog_total FROM variants WHERE product_id IN (${ph}) ORDER BY product_id ASC, price_cents ASC LIMIT ${Math.max(1, Math.min(3500, 5000 - (budget.rows ?? 0)))}`
        )
        .bind(...chunk)
        .all<{
          id: string;
          product_id: string;
          sku: string;
          title: string;
          price_cents: number;
          compare_at_cents: number | null;
          status: string;
          continue_selling: number;
          weight_grams: number | null;
          catalog_total: number;
        }>();
      if ((variants.results[0]?.catalog_total ?? 0) > variants.results.length)
        throw new Error('Product variants exceed publication unit capacity');
      for (const v of variants.results)
        (
          variantsByProduct.get(v.product_id) ??
          variantsByProduct.set(v.product_id, []).get(v.product_id)!
        ).push({
          id: v.id,
          sku: v.sku,
          title: v.title,
          priceCents: v.price_cents,
          compareAtCents: v.compare_at_cents,
          status: v.status,
          continueSelling: v.continue_selling === 1,
          weightGrams: v.weight_grams,
        });
      if (budget.rows >= 5000) throw new BudgetExhausted('rows');
      const media = await db
        .prepare(
          `SELECT pm.product_id AS product_id, m.r2_key, m.alt_text,m.public_url,(SELECT json_group_array(json_object('width',v.width,'url',COALESCE(v.public_url,'/media/'||m.r2_key||'?w='||v.width))) FROM media_variants v WHERE v.media_id=m.id AND v.ready=1 ORDER BY v.width) AS variants_json,COUNT(*) OVER() AS catalog_total FROM product_media pm JOIN media m ON m.id = pm.media_id WHERE m.ready=1 AND m.deletion_pending=0 AND pm.product_id IN (${ph}) ORDER BY pm.product_id ASC, pm.position ASC LIMIT ${Math.max(1, Math.min(3500, 5000 - (budget.rows ?? 0)))}`
        )
        .bind(...chunk)
        .all<{
          product_id: string;
          r2_key: string;
          alt_text: string;
          public_url: string | null;
          variants_json: string | null;
          catalog_total: number;
        }>();
      if ((media.results[0]?.catalog_total ?? 0) > media.results.length)
        throw new Error('Product media exceed publication unit capacity');
      for (const m of media.results)
        (
          imagesByProduct.get(m.product_id) ??
          imagesByProduct.set(m.product_id, []).get(m.product_id)!
        ).push({
          key: m.r2_key,
          alt: m.alt_text,
          publicUrl: m.public_url,
          variants: JSON.parse(m.variants_json ?? '[]'),
        });
    }
    for (const id of orderedIds) {
      const p = productById.get(id);
      if (!p) continue;
      const base = {
        id: p.id,
        slug: p.slug,
        title: p.title,
        description: p.description,
        status: p.status,
        seoTitle: p.seo_title,
        seoDescription: p.seo_description,
        variants: variantsByProduct.get(id) ?? [],
        images: imagesByProduct.get(id) ?? [],
      };
      docs.set(id, { ...base, revision: contentRevision(JSON.stringify(base)) });
    }
    return docs;
  }
  return docs;
}

// --- Incremental publication (Phase 3B) -------------------------------
// Change capture is durable: catalog_work rows are written by triggers
// in the same transaction as the source edit (migration 0004). This
// pass claims due rows, publishes only the affected products/listings,
// and marks the claimed revision processed. A row whose target advanced
// during the build stays due, so mid-build edits are never lost.

export type CatalogWorkResult = {
  processed: number;
  productsPublished: number;
  listingsRefreshed: string[];
  kvPuts: number;
  more?: boolean;
};

type CollectionMetaRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  seo_title: string | null;
  seo_description: string | null;
  kind: string;
  rule_json: string | null;
};

/** Publish one small metadata document per collection (never a
 *  growing shared document). Write-if-changed, like editorial. */
async function publishCollectionMeta(
  db: D1Database,
  kv: KvLike | undefined,
  put: PutFn,
  ids: string[]
): Promise<void> {
  const rows = await db
    .prepare(
      'SELECT id, slug, title, description, seo_title, seo_description, kind, rule_json FROM collections WHERE id IN (SELECT value FROM json_each(?)) ORDER BY slug'
    )
    .bind(JSON.stringify(ids))
    .all<CollectionMetaRow>();
  for (const row of rows.results) {
    const value = JSON.stringify({
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      seoTitle: row.seo_title,
      seoDescription: row.seo_description,
      kind: row.kind,
      ruleJson: row.rule_json,
    });
    const key = collectionMetaKey(row.slug);
    await publishDocument(db, kv, put, 'collection-meta', key, value);
  }
}

/** Unpublishes a deleted collection, write-then-advance: KV loses its
 *  pointer and listing ref first, then one batch retires the D1 mirrors
 *  and records the purge. A retry repeats the deletes; once the batch
 *  commits nothing is found and it is a no-op. */
async function retireCollection(
  db: D1Database,
  kv: KvLike | undefined,
  listingId: string
): Promise<void> {
  const refKey = `listing:${listingId}`;
  const pointerPrefix = collectionMetaKey('').slice(0, -':meta'.length);
  const found = await db
    .prepare(
      `WITH slugs AS(SELECT json_extract(d.payload_json,'$.slug') AS slug FROM catalog_documents p JOIN catalog_documents d ON d.key=json_extract(p.payload_json,'$.key')
         WHERE p.key>? AND p.key<? AND p.kind='collection-meta-pointer' AND json_extract(d.payload_json,'$.id')=?
           AND NOT EXISTS(SELECT 1 FROM collections c WHERE c.slug=json_extract(d.payload_json,'$.slug')))
       SELECT s.slug,EXISTS(SELECT 1 FROM catalog_ref_state WHERE ref_key=?) AS published,
         EXISTS(SELECT 1 FROM catalog_ref_state r JOIN catalog_documents l ON l.key=?||r.root_hash JOIN json_each(l.payload_json,'$.featured') f
           WHERE r.ref_key='layout' AND json_extract(f.value,'$.slug') IN (SELECT slug FROM slugs)) AS featured
       FROM (SELECT 1) LEFT JOIN slugs s`
    )
    .bind(pointerPrefix, `${pointerPrefix}\uffff`, listingId, refKey, layoutKey(''))
    .all<{ slug: string | null; published: number; featured: number }>();
  const slugs = found.results.flatMap((row) => (row.slug ? [row.slug] : []));
  if (!slugs.length && !found.results.some((row) => row.published)) return;
  const pointers = slugs.map(collectionMetaKey);
  if (kv?.delete) for (const key of [...pointers, listingRefKey(listingId)]) await kv.delete(key);
  const at = now();
  await db.batch([
    db
      .prepare('DELETE FROM catalog_documents WHERE key IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(pointers)),
    db.prepare('DELETE FROM catalog_ref_state WHERE ref_key=?').bind(refKey),
    db
      .prepare(
        'UPDATE catalog_listing_ref_history SET retired_at=? WHERE listing_id=? AND retired_at IS NULL'
      )
      .bind(at, listingId),
    db
      .prepare(
        "UPDATE catalog_listings SET active=0,state='superseded',updated_at=? WHERE listing_id=? AND active=1"
      )
      .bind(at, listingId),
    ...invalidationStatements(db, [
      ...slugs.map((slug) => ({ scope: 'listing', scopeId: slug, listingId })),
      ...(found.results.some((row) => row.featured)
        ? [{ scope: 'listing', scopeId: FEATURED_INDEX }]
        : []),
    ]),
  ]);
}

/** Create (once) a scoped listing build for a large membership
 *  change. The queue unit runner drives it one bounded unit at a
 *  time; duplicate scheduling is a no-op while one is open. */
export async function scheduleScopedListingBuild(
  db: D1Database,
  listingId: string,
  parentId?: string
): Promise<void> {
  const open = await db
    .prepare(
      "SELECT id FROM catalog_builds WHERE scope_listing_id = ? AND state IN ('building', 'pending_delivery') LIMIT 1"
    )
    .bind(listingId)
    .first<{ id: string }>();
  if (open) return;
  const id = crypto.randomUUID();
  const at = now();
  const revRow = await db
    .prepare('SELECT COALESCE(MAX(target_revision), 0) AS rev FROM catalog_work')
    .first<{ rev: number }>();
  await db.batch([
    db
      .prepare(
        "INSERT INTO catalog_builds (id, kind, state, phase, state_json, parent_id, scope_listing_id, source_revision, created_at, updated_at) VALUES (?, 'listing', 'building', 'memberships', ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        id,
        JSON.stringify({ ...freshBuildState(), layoutDone: true }),
        parentId ?? null,
        listingId,
        revRow?.rev ?? 0,
        at,
        at
      ),
    db
      .prepare('INSERT INTO catalog_build_listings (build_id, listing_id) VALUES (?, ?)')
      .bind(id, listingId),
  ]);
}

/** Time-based editorial promotion (moved from the retired snapshot
 *  cron): scheduled posts become published when due. The posts capture
 *  trigger then queues their republication like any other edit. */
export async function promoteScheduledPosts(db: D1Database): Promise<void> {
  const at = now();
  await db
    .prepare(
      "UPDATE posts SET status='published', updated_at=? WHERE id IN(SELECT id FROM posts WHERE status='scheduled' AND published_at IS NOT NULL AND published_at<=? ORDER BY published_at,id LIMIT 50)"
    )
    .bind(at, at)
    .run();
}

/** Wake-up enqueue for the catalog consumer. Durable capture lives in
 *  the catalog_work triggers; this only nudges the queue, and failures
 *  are logged, never fatal to the mutation that triggered it. */
export async function enqueueCatalogRebuild(env: {
  CATALOG_JOBS?: { send: (message: { type: 'catalog.rebuild' }) => Promise<unknown> };
}): Promise<void> {
  try {
    await env.CATALOG_JOBS?.send({ type: 'catalog.rebuild' });
  } catch (error) {
    console.error(JSON.stringify({ event: 'catalog_enqueue_failed', error: String(error) }));
  }
}

/** Cards for an explicit ID set from the D1 card projection
 *  (chunked under the bind limit). */
async function listingCardsByIds(db: D1Database, ids: string[]): Promise<Map<string, CatalogCard>> {
  const out = new Map<string, CatalogCard>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await db
      .prepare(
        `SELECT product_id, card_json FROM catalog_cards WHERE product_id IN (${placeholders(chunk.length)})`
      )
      .bind(...chunk)
      .all<{ product_id: string; card_json: string }>();
    for (const r of rows.results) out.set(r.product_id, JSON.parse(r.card_json) as CatalogCard);
  }
  return out;
}

type WorkCollection = {
  id: string;
  title: string;
  slug: string;
  kind: string;
  rule_json: string | null;
};

async function isMemberNow(
  db: D1Database,
  listingId: string,
  col: WorkCollection | undefined,
  pid: string,
  freshCards: Map<string, CatalogCard>
): Promise<boolean> {
  const card = freshCards.get(pid) ?? (await listingCardsByIds(db, [pid])).get(pid);
  if (!card) return false;
  if (listingId === ALL_LISTING) return true;
  if (!col) return false;
  if (col.kind === 'manual') {
    const r = await db
      .prepare('SELECT 1 AS x FROM product_collections WHERE collection_id = ? AND product_id = ?')
      .bind(col.id, pid)
      .first();
    return Boolean(r);
  }
  if (col.kind === 'rule') {
    const rule = parseRule(col.rule_json);
    if (!rule) return false;
    if (rule.type === 'title_contains') return card.title.includes(rule.value);
    if (card.priceCents == null) return false;
    return rule.type === 'price_lte'
      ? card.priceCents <= rule.value
      : card.priceCents >= rule.value;
  }
  return false;
}

/** Incremental refresh for one listing. Changed products are first
 *  evaluated against this listing only: no membership delta means
 *  only the pages containing changed cards are patched (found via
 *  the product-to-page index); a delta, a listing edit, or a missing
 *  active generation recomputes membership with listing-scoped
 *  queries, delegating large listings to a scoped build. */
async function refreshAffectedListing(
  db: D1Database,
  kv: KvLike | undefined,
  put: PutFn,
  listingId: string,
  ctx: {
    cardsById: Map<string, CatalogCard>;
    productIds: Set<string>;
    cardChangedIds: Set<string>;
    collectionEdited: boolean;
    collections: WorkCollection[];
    lease?: CatalogLease;
    budget: CatalogBudget;
    preparePublication?: (publication: ListingPublication) => Promise<void>;
  }
): Promise<boolean> {
  const pageSize = listingId === ALL_LISTING ? HOME_PAGE_SIZE : COLLECTION_PAGE_SIZE;
  const col = ctx.collections.find((c) => c.id === listingId);
  const active = await db
    .prepare(
      'SELECT generation, page_count, total FROM catalog_listings WHERE listing_id = ? AND active = 1'
    )
    .bind(listingId)
    .first<{ generation: number; page_count: number; total: number }>();
  let delta = ctx.collectionEdited;
  if (!delta && active) {
    for (const pid of ctx.productIds) {
      const was = await db
        .prepare(
          'SELECT 1 AS x FROM catalog_page_products WHERE product_id = ? AND listing_id = ? AND generation = ? LIMIT 1'
        )
        .bind(pid, listingId, active.generation)
        .first();
      const is = await isMemberNow(db, listingId, col, pid, ctx.cardsById);
      if (Boolean(was) !== is) {
        delta = true;
        break;
      }
    }
  }
  if (!active || delta) {
    await scheduleScopedListingBuild(db, listingId);
    return true;
  }
  if (!ctx.productIds.size) return false;
  const changedPages = new Set<number>();
  const changedList = [...ctx.productIds];
  for (let i = 0; i < changedList.length; i += CHUNK) {
    const chunk = changedList.slice(i, i + CHUNK);
    const rows = await db
      .prepare(
        `SELECT DISTINCT page FROM catalog_page_products WHERE listing_id = ? AND generation = ? AND product_id IN (${placeholders(chunk.length)})`
      )
      .bind(listingId, active.generation, ...chunk)
      .all<{ page: number }>();
    for (const r of rows.results) changedPages.add(r.page);
  }
  if (!changedPages.size) return false;
  const refState = await db
    .prepare('SELECT root_hash FROM catalog_ref_state WHERE ref_key = ?')
    .bind(`listing:${listingId}`)
    .first<{ root_hash: string | null }>();
  const currentRevisions = new Map<number, string>();
  if (refState?.root_hash)
    for (const page of changedPages) {
      const revision = await resolveDirectoryRevision(db, undefined, refState.root_hash, page);
      if (revision) currentRevisions.set(page, revision);
    }
  const newRevisions = new Map<number, string>();
  let changed = false;
  for (const page of changedPages) {
    const members = await db
      .prepare(
        'SELECT product_id FROM catalog_membership WHERE listing_id = ? AND position >= ? AND position < ? ORDER BY position'
      )
      .bind(listingId, (page - 1) * pageSize, page * pageSize)
      .all<{ product_id: string }>();
    const pageCardsMap = await listingCardsByIds(
      db,
      members.results.map((m) => m.product_id)
    );
    for (const [id, card] of ctx.cardsById) if (pageCardsMap.has(id)) pageCardsMap.set(id, card);
    const pageCards = members.results
      .map((m) => pageCardsMap.get(m.product_id))
      .filter((c): c is CatalogCard => Boolean(c));
    const payload: ListingPage = {
      listingId,
      generation: active.generation,
      page,
      pageSize,
      total: active.total,
      pageCount: active.page_count,
      cards: pageCards,
    };
    const revision = listingPageRevision(payload);
    if (currentRevisions.get(page) === revision) continue;
    changed = true;
    if (kv) await put(listingPageKey(listingId, page, revision), serializeListingPage(payload));
    await db
      .prepare(
        `INSERT INTO catalog_listing_page_revisions (listing_id, generation, page, revision, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(listing_id, generation, page, revision) DO NOTHING`
      )
      .bind(listingId, active.generation, page, revision, serializeListingPage(payload), now())
      .run();
    newRevisions.set(page, revision);
  }
  if (!changed) return false;
  let rootHash = refState!.root_hash!;
  for (const [page, revision] of newRevisions)
    rootHash = await patchDirectory(db, kv, put, listingId, rootHash, page, revision);
  const pub: ListingPublication = {
    listingId,
    generation: active.generation,
    pageSize,
    total: active.total,
    pageCount: active.page_count,
    rootHash,
  };
  if (ctx.preparePublication) {
    await ctx.preparePublication(pub);
    return true;
  }
  const seq = await commitListingPublication(db, pub);
  await deliverListingRef(db, kv, put, pub, seq, ctx.lease);
  return true;
}

export async function processCatalogWork(
  db: D1Database,
  kv: KvLike | undefined,
  opts: { budget: CatalogBudget; limit?: number; lease?: CatalogLease }
): Promise<CatalogWorkResult> {
  const { budget, lease } = opts;
  const limit = opts.limit ?? 50;
  let kvPuts = 0;
  const put = async (key: string, value: string) => {
    if (!kv) return;
    await kv.put(key, value);
    kvPuts++;
  };
  await promoteScheduledPosts(db);
  const due = await db
    .prepare(
      `SELECT id, entity_type, entity_id, entity_slug, target_revision FROM catalog_work
       WHERE processed_revision < target_revision AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY updated_at ASC LIMIT ?`
    )
    .bind(now(), limit)
    .all<{
      id: string;
      entity_type: string;
      entity_id: string;
      entity_slug: string | null;
      target_revision: number;
    }>();
  if (!due.results.length)
    return { processed: 0, productsPublished: 0, listingsRefreshed: [], kvPuts: 0 };

  const token = crypto.randomUUID();
  const claimed: typeof due.results = [];
  for (const row of due.results) {
    const res = await db
      .prepare(
        `UPDATE catalog_work SET build_token = ? WHERE id = ? AND processed_revision < target_revision
         AND (build_token IS NULL OR updated_at <= ?)`
      )
      .bind(token, row.id, new Date(Date.now() - 2 * 60_000).toISOString())
      .run();
    if ((res.meta.changes ?? 0) > 0) claimed.push(row);
  }
  if (!claimed.length)
    return { processed: 0, productsPublished: 0, listingsRefreshed: [], kvPuts: 0 };
  // The finish batch: fence guard, invalidations, both index schedules,
  // one ack per claimed row and the done marker; then the lease release.
  budget.reserve(claimed.length + 6);

  try {
    const checkpointId = claimed.length === 1 ? `work-${claimed[0]!.id}` : null;
    const checkpoint = checkpointId
      ? await db
          .prepare('SELECT source_revision,state_json FROM catalog_builds WHERE id=?')
          .bind(checkpointId)
          .first<{ source_revision: number; state_json: string }>()
      : null;
    const progress =
      checkpoint && checkpoint.source_revision === claimed[0]!.target_revision
        ? (JSON.parse(checkpoint.state_json) as {
            stage: 'listings' | 'publication' | 'editorial' | 'layout';
            lastListing: string;
            cardChanged: boolean;
          })
        : null;
    const invalidations: InvalidationEntry[] = [];
    // Checkpoints record the invalidations gathered so far: replayed work
    // is content-addressed and would not gather them again.
    const saveWork = async (
      stage: NonNullable<typeof progress>['stage'],
      lastListing: string,
      cardChanged: boolean,
      publication?: ListingPublication
    ) => {
      if (!checkpointId) return;
      await budget.finalize(() =>
        db.batch([
          ...(publication
            ? [
                db
                  .prepare(
                    'INSERT INTO catalog_build_listings(build_id,listing_id,generation,root_hash,page_count,total,changed) VALUES(?,?,?,?,?,?,1) ON CONFLICT(build_id,listing_id) DO UPDATE SET generation=excluded.generation,root_hash=excluded.root_hash,page_count=excluded.page_count,total=excluded.total,changed=1'
                  )
                  .bind(
                    checkpointId,
                    publication.listingId,
                    publication.generation,
                    publication.rootHash,
                    publication.pageCount,
                    publication.total
                  ),
              ]
            : []),
          db
            .prepare(
              "INSERT INTO catalog_builds(id,kind,state,phase,state_json,source_revision,created_at,updated_at) VALUES(?,'work','waiting','work',?,?,?,?) ON CONFLICT(id) DO UPDATE SET state='waiting',state_json=excluded.state_json,source_revision=excluded.source_revision,updated_at=excluded.updated_at"
            )
            .bind(
              checkpointId,
              JSON.stringify({ stage, lastListing, cardChanged }),
              claimed[0]!.target_revision,
              now(),
              now()
            ),
          ...invalidationStatements(db, invalidations),
          db
            .prepare('UPDATE catalog_work SET build_token=NULL WHERE id=? AND build_token=?')
            .bind(claimed[0]!.id, token),
        ])
      );
    };

    if (checkpointId && progress?.stage === 'publication') {
      const prepared = await db
        .prepare(
          'SELECT b.listing_id,b.generation,b.root_hash,b.page_count,b.total,b.changed,c.slug FROM catalog_build_listings b LEFT JOIN collections c ON c.id=b.listing_id WHERE b.build_id=? AND b.listing_id=?'
        )
        .bind(checkpointId, progress.lastListing)
        .first<{
          listing_id: string;
          generation: number;
          root_hash: string;
          page_count: number;
          total: number;
          changed: number;
          slug: string | null;
        }>();
      if (!prepared) throw new Error('Prepared catalog publication is missing');
      if (prepared.changed === 1) {
        await commitListingPublication(
          db,
          {
            listingId: prepared.listing_id,
            generation: prepared.generation,
            rootHash: prepared.root_hash,
            total: prepared.total,
            pageCount: prepared.page_count,
            pageSize: prepared.listing_id === ALL_LISTING ? HOME_PAGE_SIZE : COLLECTION_PAGE_SIZE,
          },
          [
            db
              .prepare(
                'UPDATE catalog_build_listings SET changed=2 WHERE build_id=? AND listing_id=?'
              )
              .bind(checkpointId, prepared.listing_id),
            ...invalidationStatements(db, [
              {
                scope: 'listing',
                scopeId:
                  prepared.listing_id === ALL_LISTING
                    ? 'all'
                    : (prepared.slug ?? prepared.listing_id),
                listingId: prepared.listing_id,
              },
            ]),
          ]
        );
      }
      // Delivery is already durable in catalog_ref_state. The next
      // invocation drains it; activation and artifact preparation must
      // not compete for the same statement budget.
      await saveWork('listings', prepared.listing_id, progress.cardChanged);
      return {
        processed: 0,
        productsPublished: 0,
        listingsRefreshed: [prepared.listing_id],
        kvPuts,
        more: true,
      };
    }
    const productIds = new Set<string>();
    const deferredWorkRows = new Set<string>();
    const collectionIds = new Set<string>();
    const postIds: string[] = [];
    const pageIds: string[] = [];
    for (const row of claimed) {
      if (row.entity_type === 'product') productIds.add(row.entity_id);
      else if (row.entity_type === 'media') {
        // Keyset fan-out slice: at most CHUNK linked products per
        // pass, cursor persisted on a fanout build row; the work row
        // stays due until the cursor is exhausted.
        const fanout = await db
          .prepare(
            "SELECT id, state_json,source_revision FROM catalog_builds WHERE kind = 'fanout' AND scope_listing_id = ? AND state = 'building' LIMIT 1"
          )
          .bind(`media:${row.entity_id}`)
          .first<{ id: string; state_json: string; source_revision: number | null }>();
        const cursor =
          fanout && fanout.source_revision === row.target_revision
            ? ((JSON.parse(fanout.state_json) as { cursor?: string }).cursor ?? '')
            : '';
        const linked = await db
          .prepare(
            'SELECT product_id FROM product_media WHERE media_id = ? AND product_id > ? ORDER BY product_id LIMIT ?'
          )
          .bind(row.entity_id, cursor, CHUNK)
          .all<{ product_id: string }>();
        await db
          .prepare(
            "INSERT INTO catalog_work(id,entity_type,entity_id,target_revision,processed_revision,created_at,updated_at) SELECT 'product:'||value,'product',value,1,0,?,? FROM json_each(?) WHERE true ON CONFLICT(entity_type,entity_id) DO UPDATE SET target_revision=target_revision+1,updated_at=excluded.updated_at"
          )
          .bind(now(), now(), JSON.stringify(linked.results.map((l) => l.product_id)))
          .run();
        if (linked.results.length === CHUNK) {
          const lastId = linked.results[linked.results.length - 1]!.product_id;
          const stateJson = JSON.stringify({ cursor: lastId });
          if (fanout)
            await db
              .prepare(
                'UPDATE catalog_builds SET state_json = ?,source_revision=?, updated_at = ? WHERE id = ?'
              )
              .bind(stateJson, row.target_revision, now(), fanout.id)
              .run();
          else
            await db
              .prepare(
                "INSERT INTO catalog_builds (id, kind, state, phase, state_json, scope_listing_id,source_revision, created_at, updated_at) VALUES (?, 'fanout', 'building', 'fanout', ?, ?, ?, ?,?)"
              )
              .bind(
                crypto.randomUUID(),
                stateJson,
                `media:${row.entity_id}`,
                row.target_revision,
                now(),
                now()
              )
              .run();
          deferredWorkRows.add(row.id);
        } else if (fanout) {
          await db
            .prepare("UPDATE catalog_builds SET state = 'done', phase = 'done' WHERE id = ?")
            .bind(fanout.id)
            .run();
        }
      } else if (row.entity_type === 'collection') collectionIds.add(row.entity_id);
      else if (row.entity_type === 'post') postIds.push(row.entity_id);
      else if (row.entity_type === 'page') pageIds.push(row.entity_id);
    }

    // Targeted cards for exactly the affected products — never a
    // catalog-wide source read for an incremental pass.
    const affectedIdList = [...productIds];
    const freshCards = affectedIdList.length
      ? await listPublishedProductsByIds(db, affectedIdList)
      : [];
    const cardsById = new Map(
      freshCards.filter((c) => c.status === 'active').map((c) => [c.id, c as CatalogCard])
    );
    let productsPublished = 0;
    const cardChangedIds = new Set<string>();

    // Publish affected products (cards + documents), removing stale ones.
    if (productIds.size && !progress) {
      const docs = await buildProductDocuments(db, [...productIds], budget);
      const productIdList = [...productIds];
      const existingById = new Map<
        string,
        { product_id: string; slug: string; revision: string; doc_revision: string }
      >();
      for (let i = 0; i < productIdList.length; i += CHUNK) {
        const chunk = productIdList.slice(i, i + CHUNK);
        const existing = await db
          .prepare(
            `SELECT product_id, slug, revision, doc_revision FROM catalog_cards WHERE product_id IN (${placeholders(chunk.length)})`
          )
          .bind(...chunk)
          .all<{ product_id: string; slug: string; revision: string; doc_revision: string }>();
        for (const r of existing.results) existingById.set(r.product_id, r);
      }
      const at = now();
      for (const pid of productIds) {
        const card = cardsById.get(pid);
        const prev = existingById.get(pid);
        if (!card) {
          if (prev) {
            const slugRow = await db
              .prepare('SELECT slug FROM catalog_cards WHERE product_id = ?')
              .bind(pid)
              .first<{ slug: string }>();
            cardChangedIds.add(pid);
            await db.prepare('DELETE FROM catalog_cards WHERE product_id = ?').bind(pid).run();
            if (slugRow && kv?.delete) await kv.delete(productSlugKey(slugRow.slug));
            if (slugRow) invalidations.push({ scope: 'product', scopeId: slugRow.slug });
            productsPublished++;
          }
          continue;
        }
        if (prev && prev.slug !== card.slug)
          invalidations.push({ scope: 'product', scopeId: prev.slug });
        const doc = docs.get(pid);
        const cardJson = JSON.stringify(card);
        const cardRev = contentRevision(cardJson);
        if (prev?.revision !== cardRev || (doc && prev?.doc_revision !== doc.revision)) {
          // Write-then-advance: KV writes land before the D1 revision
          // columns move, so a failed put is retried next pass instead
          // of being skipped as already published.
          if (doc && prev?.doc_revision !== doc.revision) {
            invalidations.push({ scope: 'product', scopeId: card.slug });
            const docJson = JSON.stringify(doc);
            await put(productDocKey(pid, doc.revision), docJson);
            await put(
              productSlugKey(card.slug),
              JSON.stringify({ id: pid, revision: doc.revision })
            );
            await mirrorDocument(
              db,
              'product',
              productDocKey(pid, doc.revision),
              doc.revision,
              docJson
            );
          }
          if (prev && prev.slug !== card.slug)
            await publishMoves(db, put, 'products', card.slug, prev.slug);
          if (prev?.revision !== cardRev) cardChangedIds.add(pid);
          await db
            .prepare(
              `INSERT INTO catalog_cards (product_id, slug, card_json, revision, doc_revision, published_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(product_id) DO UPDATE SET slug = excluded.slug, card_json = excluded.card_json, revision = excluded.revision, doc_revision = excluded.doc_revision, published_revision = excluded.published_revision, updated_at = excluded.updated_at`
            )
            .bind(pid, card.slug, cardJson, cardRev, doc?.revision ?? '', cardRev, at)
            .run();
          productsPublished++;
        }
      }
    }

    if (checkpointId && !progress && productIds.size) {
      await saveWork('listings', '', cardChangedIds.size > 0);
      return { processed: 0, productsPublished, listingsRefreshed: [], kvPuts, more: true };
    }
    const pastListings = progress?.stage === 'editorial' || progress?.stage === 'layout';
    const listingsRefreshed: string[] = [];
    if (!pastListings) {
      const affected = new Set<string>(collectionIds);
      if (productIds.size) {
        const pid = [...productIds][0]!;
        const next = await db
          .prepare(
            "SELECT id FROM (SELECT 'all' AS id UNION SELECT c.id FROM collections c WHERE c.kind='rule' OR EXISTS(SELECT 1 FROM product_collections pc WHERE pc.product_id=? AND pc.collection_id=c.id) OR EXISTS(SELECT 1 FROM catalog_page_products pp WHERE pp.product_id=? AND pp.listing_id=c.id)) WHERE id>? ORDER BY id LIMIT 1"
          )
          .bind(pid, pid, progress?.lastListing ?? '')
          .first<{ id: string }>();
        if (next) affected.add(next.id);
      }
      const collections = await db
        .prepare(
          'SELECT id,slug,title,kind,rule_json FROM collections WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id'
        )
        .bind(JSON.stringify([...affected]))
        .all<WorkCollection>();
      if (progress?.cardChanged) for (const id of productIds) cardChangedIds.add(id);
      if (collectionIds.size && !progress)
        await publishCollectionMeta(db, kv, put, [...collectionIds]);
      for (const listingId of [...affected].sort()) {
        if (progress && listingId <= progress.lastListing) continue;
        if (budget.spent()) throw new BudgetExhausted('combined');
        if (
          listingId !== ALL_LISTING &&
          !collections.results.some((collection) => collection.id === listingId)
        ) {
          if (checkpointId && !budget.fits(RETIRE_STATEMENTS)) {
            await saveWork('listings', progress?.lastListing ?? '', cardChangedIds.size > 0);
            return { processed: 0, productsPublished, listingsRefreshed, kvPuts, more: true };
          }
          await retireCollection(db, kv, listingId);
        } else {
          let prepared = false;
          const changed = await refreshAffectedListing(db, kv, put, listingId, {
            cardsById,
            productIds,
            cardChangedIds,
            collectionEdited: collectionIds.has(listingId),
            collections: collections.results,
            budget,
            ...(lease ? { lease } : {}),
            ...(checkpointId
              ? {
                  preparePublication: async (publication: ListingPublication) => {
                    await saveWork('publication', listingId, cardChangedIds.size > 0, publication);
                    prepared = true;
                  },
                }
              : {}),
          });
          if (prepared)
            return { processed: 0, productsPublished, listingsRefreshed: [], kvPuts, more: true };
          if (changed) {
            listingsRefreshed.push(listingId);
            invalidations.push({
              scope: 'listing',
              scopeId:
                listingId === ALL_LISTING
                  ? 'all'
                  : (collections.results.find((c) => c.id === listingId)?.slug ?? listingId),
            });
          }
        }
        if (checkpointId) {
          await saveWork('listings', listingId, cardChangedIds.size > 0);
          return { processed: 0, productsPublished, listingsRefreshed, kvPuts, more: true };
        }
      }
    }

    // Editorial documents for changed posts/pages. Slugs captured on
    // the work rows (migration 0006) let a hard delete still remove
    // and invalidate its slug-keyed document after the row is gone.
    const pause = async (stage: 'editorial' | 'layout') => {
      await saveWork(stage, '', cardChangedIds.size > 0);
      return { processed: 0, productsPublished, listingsRefreshed, kvPuts, more: true };
    };
    const editorialIds = progress?.stage === 'layout' ? 0 : postIds.length + pageIds.length;
    if (editorialIds && checkpointId && !budget.fits(EDITORIAL_DOC_STATEMENTS * editorialIds))
      return pause('editorial');
    const slugById = new Map<string, string>();
    for (const row of claimed)
      if ((row.entity_type === 'post' || row.entity_type === 'page') && row.entity_slug)
        slugById.set(row.entity_id, row.entity_slug);
    for (const [kind, ids] of [
      ['post', postIds],
      ['page', pageIds],
    ] as const) {
      for (const id of editorialIds ? ids : []) {
        const row =
          kind === 'post'
            ? await db
                .prepare(
                  `SELECT slug, title, excerpt, content_html, seo_title, seo_description, published_at, status,${POST_METADATA_FIELDS} FROM posts source WHERE id = ?`
                )
                .bind(id)
                .first<{
                  slug: string;
                  title: string;
                  excerpt: string;
                  content_html: string;
                  seo_title: string | null;
                  seo_description: string | null;
                  published_at: string | null;
                  status: string;
                  cover_key: string | null;
                  author_name: string | null;
                  tags: string | null;
                }>()
            : await db
                .prepare(
                  'SELECT slug, title, content_html, seo_title, seo_description FROM pages WHERE id = ?'
                )
                .bind(id)
                .first<{
                  slug: string;
                  title: string;
                  content_html: string;
                  seo_title: string | null;
                  seo_description: string | null;
                }>();
        if (!row) {
          // Hard-deleted since capture: the slug recorded on the work
          // row still identifies the document to remove + invalidate.
          const slug = slugById.get(id);
          if (slug) {
            await unpublishDocument(db, kv, editorialKey(kind, slug));
            invalidations.push({ scope: 'editorial', scopeId: slug });
            if (kind === 'post') invalidations.push({ scope: 'editorial', scopeId: 'index' });
          }
          continue;
        }
        const post =
          kind === 'post'
            ? (row as {
                slug: string;
                title: string;
                excerpt: string;
                content_html: string;
                seo_title: string | null;
                seo_description: string | null;
                published_at: string | null;
                status: string;
              } & PostMetadata)
            : null;
        const publishable =
          kind === 'page' ||
          (post?.status === 'published' &&
            (post.published_at == null || post.published_at <= now())) ||
          (post?.status === 'scheduled' && post.published_at != null && post.published_at <= now());
        if (!publishable) {
          await unpublishDocument(db, kv, editorialKey(kind, row.slug));
          invalidations.push({ scope: 'editorial', scopeId: row.slug });
          if (kind === 'post') invalidations.push({ scope: 'editorial', scopeId: 'index' });
          continue;
        }
        const docValue = JSON.stringify({
          kind,
          slug: row.slug,
          title: row.title,
          excerpt: post?.excerpt ?? '',
          contentHtml: await publishedMediaContent(db, row.content_html),
          seoTitle: row.seo_title,
          seoDescription: row.seo_description,
          publishedAt: post?.published_at ?? null,
          coverKey: post?.cover_key ?? null,
          coverPublicUrl: post?.cover_public_url ?? null,
          tags: post?.tags ?? null,
          authorName: post?.author_name ?? null,
        });
        const docKey = editorialKey(kind, row.slug);
        const pointer = JSON.stringify({
          key: immutableDocumentKey(docKey, contentRevision(docValue)),
          revision: contentRevision(docValue),
        });
        const existingDoc = kv ? await kv.get(docKey) : null;
        const durablePointer = await db
          .prepare('SELECT payload_json FROM catalog_documents WHERE key=?')
          .bind(docKey)
          .first<{ payload_json: string }>();
        if (existingDoc !== pointer || durablePointer?.payload_json !== pointer) {
          invalidations.push({ scope: 'editorial', scopeId: row.slug });
          if (kind === 'post') invalidations.push({ scope: 'editorial', scopeId: 'index' });
          await publishDocument(db, kv, put, 'editorial', docKey, docValue);
          if (kind === 'post' && !durablePointer)
            await publishMoves(db, put, 'blog', row.slug, null);
        }
      }
    }

    const layoutDue = claimed.some((r) =>
      ['settings', 'post', 'page', 'collection'].includes(r.entity_type)
    );
    if (layoutDue && checkpointId && !budget.fits(LAYOUT_STATEMENTS)) return pause('layout');
    if (layoutDue) {
      // Layout + navigation are content-addressed: republish only on change.
      const settings = await getSettings(db);
      const layout = await buildLayoutModel(db, settings);
      const layoutRev = contentRevision(JSON.stringify({ ...layout, revision: '' }));
      const prevLayoutRef = kv ? await kv.get(LAYOUT_REF_KEY).catch(() => null) : null;
      const current = await db
        .prepare("SELECT root_hash FROM catalog_ref_state WHERE ref_key='layout'")
        .first<{ root_hash: string }>();
      if (
        !prevLayoutRef ||
        !prevLayoutRef.includes(layoutRev) ||
        current?.root_hash !== layoutRev
      ) {
        invalidations.push({ scope: 'layout', scopeId: 'layout' });
        const layoutJson = JSON.stringify({ ...layout, revision: layoutRev });
        await put(layoutKey(layoutRev), layoutJson);
        await mirrorDocument(db, 'layout', layoutKey(layoutRev), layoutRev, layoutJson);
        // The durable reference is also GC's root. Commit it before delivering
        // the mutable pointer, just as full builds do. Replay is idempotent.
        if (current?.root_hash !== layoutRev) {
          const seq =
            (await db
              .prepare('SELECT publication_seq FROM catalog_publication_state WHERE id=1')
              .first<{ publication_seq: number }>())!.publication_seq + 1;
          await db.batch([
            db
              .prepare(
                'INSERT INTO batch_guard SELECT 1 WHERE (SELECT publication_seq FROM catalog_publication_state WHERE id=1)<>?'
              )
              .bind(seq - 1),
            db
              .prepare('UPDATE catalog_publication_state SET publication_seq=? WHERE id=1')
              .bind(seq),
            db
              .prepare(
                "INSERT INTO catalog_ref_state(ref_key,committed_seq,delivered_seq,root_hash,pending_payload,updated_at) VALUES('layout',?,0,?,?,?) ON CONFLICT(ref_key) DO UPDATE SET committed_seq=excluded.committed_seq,root_hash=excluded.root_hash,pending_payload=excluded.pending_payload,delivery_retry_at=NULL,updated_at=excluded.updated_at"
              )
              .bind(seq, layoutRev, JSON.stringify({ revision: layoutRev }), now()),
            db
              .prepare(
                "INSERT OR IGNORE INTO catalog_ref_documents(ref_key,publication_seq,document_key) VALUES('layout',?,?)"
              )
              .bind(seq, layoutKey(layoutRev)),
          ]);
        }
        // The normal delivery unit respects persisted per-key write timing.
      }
    }

    // Mark claimed revisions processed together with what they publish.
    // Rows whose target advanced during this build keep processed <
    // target and stay due; media rows whose fan-out cursor is
    // unfinished stay due immediately.
    const finish = () =>
      db.batch([
        ...invalidationStatements(db, invalidations),
        ...(collectionIds.size ? [publishedIndexSchedule(db, COLLECTION_INDEX)] : []),
        ...(postIds.length ? [publishedIndexSchedule(db, POSTS_INDEX)] : []),
        ...claimed.map((row) =>
          deferredWorkRows.has(row.id)
            ? db
                .prepare(
                  'UPDATE catalog_work SET build_token = NULL, next_attempt_at = ? WHERE id = ? AND build_token = ?'
                )
                .bind(now(), row.id, token)
            : db
                .prepare(
                  'UPDATE catalog_work SET processed_revision = ?, build_token = NULL, retry_count = 0, next_attempt_at = NULL, last_error = NULL WHERE id = ? AND build_token = ?'
                )
                .bind(row.target_revision, row.id, token)
        ),
        ...(checkpointId
          ? [db.prepare("UPDATE catalog_builds SET state='done' WHERE id=?").bind(checkpointId)]
          : []),
      ]);
    await budget.finalize(finish);
    const acked = claimed.filter((row) => !deferredWorkRows.has(row.id)).length;

    return {
      processed: acked,
      productsPublished,
      listingsRefreshed,
      kvPuts,
      more: deferredWorkRows.size > 0,
    };
  } catch (error) {
    if (error instanceof BudgetExhausted) {
      await budget.finalize(() =>
        db
          .prepare(
            'UPDATE catalog_work SET build_token=NULL,next_attempt_at=NULL WHERE build_token=?'
          )
          .bind(token)
          .run()
      );
      return { processed: 0, productsPublished: 0, listingsRefreshed: [], kvPuts, more: true };
    }
    const message = (error instanceof Error ? error.message : 'unknown').slice(0, 500);
    for (const row of claimed)
      await db
        .prepare(
          `UPDATE catalog_work SET build_token = NULL, retry_count = retry_count + 1, last_error = ?,
           next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || MIN(?, ? << MIN(retry_count, 6)) || ' seconds')
           WHERE id = ? AND build_token = ?`
        )
        .bind(
          message,
          new Date().toISOString(),
          WORK_RETRY_MAX_SECONDS,
          WORK_RETRY_BASE_SECONDS,
          row.id,
          token
        )
        .run()
        .catch(() => undefined);
    console.error(JSON.stringify({ event: 'catalog_work_failed', error: message }));
    throw error;
  }
}

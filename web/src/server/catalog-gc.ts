import { BudgetExhausted, leaseGuardStatement, type CatalogLease } from './catalog-exec';
import {
  contentRevision,
  directoryNodeSchema,
  directoryKey,
  listingPageKey,
  listingRefKey,
  productDocKey,
  productSlugKey,
  layoutKey,
  LAYOUT_REF_KEY,
  ALL_LISTING,
} from './catalog-models';

const PAGE = 100;
/** Artifacts one sweep unit claims and deletes together. */
export const GC_DELETE_BATCH = 50;
const PAGE_REVISION_DELETE_LIMIT = 500;
export const CATALOG_RETENTION_MS = 7 * 24 * 60 * 60_000;
const TERMINAL = "('done','acknowledged','failed','canceled')";
export type ReclaimKv = {
  delete?(key: string): Promise<void>;
  list?(options: {
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
};
type State = {
  phase: string;
  step: number;
  cursor: string;
  epoch: number;
  source_revision: number;
  started_at: string | null;
  next_run_at: string | null;
};
type Artifact = {
  key: string;
  kind: string;
  listing_id: string | null;
  page: number | null;
  revision: string | null;
  unreferenced_at: string | null;
  mark_epoch: number;
  retry_at: string | null;
};
const infer = (key: string) => (key.startsWith('catalog:r1:dir:') ? 'directory' : 'artifact');

function guard(db: D1Database, s: State, lease: CatalogLease): D1PreparedStatement[] {
  return [
    leaseGuardStatement(db, lease),
    db
      .prepare(
        `INSERT INTO batch_guard SELECT 1 WHERE
    (SELECT gc_revision FROM catalog_publication_state WHERE id=1)<>? OR
    EXISTS(SELECT 1 FROM catalog_builds WHERE state NOT IN ${TERMINAL})`
      )
      .bind(s.source_revision),
  ];
}
function save(db: D1Database, s: State) {
  return db
    .prepare(
      'UPDATE catalog_gc_state SET phase=?,step=?,cursor=?,epoch=?,source_revision=?,started_at=?,next_run_at=? WHERE id=1'
    )
    .bind(s.phase, s.step, s.cursor, s.epoch, s.source_revision, s.started_at, s.next_run_at);
}
function mark(db: D1Database, keys: string[]) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO catalog_gc_marks(key,kind)
    SELECT json_extract(value,'$.key'),json_extract(value,'$.kind') FROM json_each(?)`
    )
    .bind(JSON.stringify(keys.map((key) => ({ key, kind: infer(key) }))));
}
async function inventory(
  db: D1Database,
  rows: Array<{ key: string; kind: string; listingId?: string; page?: number; revision?: string }>,
  s: State,
  lease: CatalogLease
) {
  await db.batch([
    ...guard(db, s, lease),
    db
      .prepare(
        `INSERT INTO catalog_artifacts(key,kind,listing_id,page,revision)
    SELECT json_extract(value,'$.key'),json_extract(value,'$.kind'),json_extract(value,'$.listingId'),json_extract(value,'$.page'),json_extract(value,'$.revision') FROM json_each(?) WHERE true
    ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,listing_id=excluded.listing_id,page=excluded.page,revision=excluded.revision WHERE kind IS NOT excluded.kind OR listing_id IS NOT excluded.listing_id OR page IS NOT excluded.page OR revision IS NOT excluded.revision`
      )
      .bind(JSON.stringify(rows)),
    save(db, s),
  ]);
}

/** One durable bounded unit. Publication wins between units; an advancing
 * reference epoch restarts marking before any more deletion. Live builds
 * conservatively defer GC, including their uncommitted staged artifacts. */
export async function runCatalogGcUnit(
  db: D1Database,
  kv: ReclaimKv | undefined,
  lease: CatalogLease,
  nowMs = Date.now()
): Promise<boolean | null> {
  const row = await db
    .prepare(
      `SELECT g.*,p.gc_revision,
    EXISTS(SELECT 1 FROM catalog_builds WHERE state NOT IN ${TERMINAL}) AS busy
    FROM catalog_gc_state g JOIN catalog_publication_state p ON p.id=g.id WHERE g.id=1`
    )
    .first<State & { gc_revision: number; busy: number }>();
  if (!row || row.busy) return null;
  const s: State = { ...row },
    now = new Date(nowMs).toISOString(),
    cutoff = new Date(nowMs - CATALOG_RETENTION_MS).toISOString();
  if (s.phase === 'idle') {
    if (s.next_run_at && s.next_run_at > now) return null;
    s.phase = 'reset';
    s.source_revision = row.gc_revision;
  }
  if (s.source_revision !== row.gc_revision) {
    s.phase = 'reset';
    s.cursor = '';
    s.step = 0;
    s.source_revision = row.gc_revision;
  }
  if (s.phase === 'reset') {
    const result = await db.batch([
      ...guard(db, s, lease),
      db.prepare(
        'DELETE FROM catalog_gc_marks WHERE key IN (SELECT key FROM catalog_gc_marks LIMIT 100)'
      ),
    ]);
    if ((result[2]!.meta.changes ?? 0) < PAGE) {
      s.phase = 'inventory';
      s.step = 0;
      s.cursor = '';
      s.epoch++;
      s.started_at = now;
    }
    await db.batch([...guard(db, s, lease), save(db, s)]);
    return false;
  }
  if (s.phase === 'inventory') {
    if (s.step === 0) {
      const rows = await db
        .prepare('SELECT key,revision FROM catalog_documents WHERE key>? ORDER BY key LIMIT 100')
        .bind(s.cursor)
        .all<{ key: string; revision: string }>();
      s.cursor = rows.results.at(-1)?.key ?? s.cursor;
      if (rows.results.length < PAGE) {
        s.step++;
        s.cursor = '';
      }
      await inventory(
        db,
        rows.results.map((r) => ({ ...r, kind: 'document' })),
        s,
        lease
      );
      return false;
    }
    if (s.step === 1) {
      const rows = await db
        .prepare('SELECT hash FROM catalog_ref_chunks WHERE hash>? ORDER BY hash LIMIT 100')
        .bind(s.cursor)
        .all<{ hash: string }>();
      s.cursor = rows.results.at(-1)?.hash ?? s.cursor;
      if (rows.results.length < PAGE) {
        s.step++;
        s.cursor = '';
      }
      await inventory(
        db,
        rows.results.map((r) => ({
          key: directoryKey(r.hash),
          kind: 'directory',
          revision: r.hash,
        })),
        s,
        lease
      );
      return false;
    }
    if (s.step === 2) {
      const cursor = s.cursor
        ? (JSON.parse(s.cursor) as [string, number, number, string])
        : ['', 0, 0, ''];
      const rows = await db
        .prepare(
          'SELECT listing_id,generation,page,revision FROM catalog_listing_page_revisions WHERE (listing_id,generation,page,revision)>(?,?,?,?) ORDER BY listing_id,generation,page,revision LIMIT 100'
        )
        .bind(...cursor)
        .all<{ listing_id: string; generation: number; page: number; revision: string }>();
      const last = rows.results.at(-1);
      if (last)
        s.cursor = JSON.stringify([last.listing_id, last.generation, last.page, last.revision]);
      if (rows.results.length < PAGE) {
        s.step++;
        s.cursor = '';
      }
      await inventory(
        db,
        rows.results.map((r) => ({
          key: listingPageKey(r.listing_id, r.page, r.revision),
          kind: 'page',
          listingId: r.listing_id,
          page: r.page,
          revision: r.revision,
        })),
        s,
        lease
      );
      return false;
    }
    if (kv?.list) {
      const rows = await kv.list({
        prefix: 'catalog:r1:',
        limit: PAGE,
        ...(s.cursor ? { cursor: s.cursor } : {}),
      });
      s.cursor = rows.cursor ?? '';
      if (rows.list_complete) {
        s.phase = 'roots';
        s.step = 0;
        s.cursor = '';
      }
      // KV-only remnants include interrupted writes that never got a mirror.
      // Never overwrite a known artifact's kind or durable identity.
      await db.batch([
        ...guard(db, s, lease),
        db
          .prepare(
            "INSERT OR IGNORE INTO catalog_artifacts(key,kind) SELECT value,'kv' FROM json_each(?)"
          )
          .bind(JSON.stringify(rows.keys.map((k) => k.name))),
        save(db, s),
      ]);
      return false;
    }
    s.phase = 'roots';
    s.step = 0;
    s.cursor = '';
    await db.batch([...guard(db, s, lease), save(db, s)]);
    return false;
  }
  if (s.phase === 'roots') {
    let keys: string[] = [],
      length = 0;
    if (s.step === 0) {
      const cursor = s.cursor ? (JSON.parse(s.cursor) as [string, number, string]) : ['', -1, ''];
      const rows = await db
        .prepare(
          `SELECT d.ref_key,d.publication_seq,d.document_key FROM catalog_ref_documents d
        WHERE (d.ref_key,d.publication_seq,d.document_key)>(?,?,?) AND
        (d.retired_at IS NULL OR d.retired_at>? OR EXISTS(SELECT 1 FROM catalog_ref_state r WHERE r.ref_key=d.ref_key AND r.committed_seq=d.publication_seq))
        ORDER BY d.ref_key,d.publication_seq,d.document_key LIMIT 100`
        )
        .bind(...cursor, cutoff)
        .all<{ ref_key: string; publication_seq: number; document_key: string }>();
      length = rows.results.length;
      keys = rows.results.map((r) => r.document_key);
      const last = rows.results.at(-1);
      if (last) s.cursor = JSON.stringify([last.ref_key, last.publication_seq, last.document_key]);
    } else if (s.step === 1) {
      const cursor = s.cursor ? (JSON.parse(s.cursor) as [string, number, number]) : ['', -1, -1];
      const rows = await db
        .prepare(
          `SELECT listing_id,generation,publication_seq,root_hash FROM catalog_listing_ref_history
        WHERE (listing_id,generation,publication_seq)>(?,?,?) AND (retired_at IS NULL OR retired_at>?) ORDER BY listing_id,generation,publication_seq LIMIT 100`
        )
        .bind(...cursor, cutoff)
        .all<{
          listing_id: string;
          generation: number;
          publication_seq: number;
          root_hash: string;
        }>();
      length = rows.results.length;
      keys = rows.results.map((r) => directoryKey(r.root_hash));
      const last = rows.results.at(-1);
      if (last) s.cursor = JSON.stringify([last.listing_id, last.generation, last.publication_seq]);
    } else if (s.step === 2) {
      const rows = await db
        .prepare(
          'SELECT ref_key,root_hash FROM catalog_ref_state WHERE ref_key>? ORDER BY ref_key LIMIT 100'
        )
        .bind(s.cursor)
        .all<{ ref_key: string; root_hash: string | null }>();
      length = rows.results.length;
      s.cursor = rows.results.at(-1)?.ref_key ?? s.cursor;
      keys = rows.results.flatMap((r) =>
        r.ref_key === 'layout'
          ? [LAYOUT_REF_KEY, ...(r.root_hash ? [layoutKey(r.root_hash)] : [])]
          : r.ref_key.startsWith('listing:')
            ? [
                listingRefKey(r.ref_key.slice(8)),
                ...(r.root_hash ? [directoryKey(r.root_hash)] : []),
              ]
            : []
      );
    } else if (s.step === 3) {
      const rows = await db
        .prepare(
          'SELECT product_id,slug,doc_revision FROM catalog_cards WHERE product_id>? ORDER BY product_id LIMIT 100'
        )
        .bind(s.cursor)
        .all<{ product_id: string; slug: string; doc_revision: string }>();
      length = rows.results.length;
      s.cursor = rows.results.at(-1)?.product_id ?? s.cursor;
      keys = rows.results.flatMap((r) => [
        productSlugKey(r.slug),
        productDocKey(r.product_id, r.doc_revision),
      ]);
    } else {
      const rows = await db
        .prepare(
          `SELECT key,CASE WHEN kind LIKE '%-pointer' THEN json_extract(payload_json,'$.key') END AS target FROM catalog_documents WHERE key>? ORDER BY key LIMIT 100`
        )
        .bind(s.cursor)
        .all<{ key: string; target: string | null }>();
      length = rows.results.length;
      s.cursor = rows.results.at(-1)?.key ?? s.cursor;
      keys = rows.results.filter((r) => r.target).flatMap((r) => [r.key, r.target!]);
    }
    if (length < PAGE) {
      s.step++;
      s.cursor = '';
    }
    if (s.step > 4) {
      s.phase = 'mark';
      s.step = 0;
    }
    await db.batch([...guard(db, s, lease), mark(db, keys), save(db, s)]);
    return false;
  }
  if (s.phase === 'mark') {
    const artifacts = await db
      .prepare(
        "SELECT key FROM catalog_gc_marks WHERE processed=0 AND kind='artifact' ORDER BY key LIMIT 100"
      )
      .all<{ key: string }>();
    if (artifacts.results.length) {
      const keys = JSON.stringify(artifacts.results.map((r) => r.key));
      await db.batch([
        ...guard(db, s, lease),
        db
          .prepare(
            'UPDATE catalog_artifacts SET mark_epoch=?,unreferenced_at=NULL,deletion_pending=0,retry_at=NULL,failure=NULL WHERE key IN (SELECT value FROM json_each(?))'
          )
          .bind(s.epoch, keys),
        db
          .prepare(
            'UPDATE catalog_gc_marks SET processed=1 WHERE key IN (SELECT value FROM json_each(?))'
          )
          .bind(keys),
      ]);
      return false;
    }
    const dir = await db
      .prepare(
        "SELECT key FROM catalog_gc_marks WHERE processed=0 AND kind='directory' ORDER BY key LIMIT 1"
      )
      .first<{ key: string }>();
    if (dir) {
      const row = await db
        .prepare(
          'SELECT listing_id,CASE WHEN length(CAST(payload_json AS BLOB))<=65536 THEN payload_json END AS payload_json FROM catalog_ref_chunks WHERE hash=?'
        )
        .bind(dir.key.slice('catalog:r1:dir:'.length))
        .first<{ listing_id: string; payload_json: string | null }>();
      if (!row?.payload_json || directoryKey(contentRevision(row.payload_json)) !== dir.key)
        throw new Error('Referenced catalog directory mirror is missing or invalid');
      const node = directoryNodeSchema.parse(JSON.parse(row.payload_json));
      const children =
        node.kind === 'pages'
          ? node.entries.map((e) => listingPageKey(row.listing_id, e.page, e.revision))
          : node.entries.map((e) => directoryKey(e.hash));
      await db.batch([
        ...guard(db, s, lease),
        mark(db, children),
        db
          .prepare(
            'UPDATE catalog_artifacts SET mark_epoch=?,unreferenced_at=NULL,deletion_pending=0,retry_at=NULL,failure=NULL WHERE key=?'
          )
          .bind(s.epoch, dir.key),
        db.prepare('UPDATE catalog_gc_marks SET processed=1 WHERE key=?').bind(dir.key),
      ]);
      return false;
    }
    s.phase = 'sweep';
    s.cursor = '';
    await db.batch([...guard(db, s, lease), save(db, s)]);
    return false;
  }
  if (s.phase === 'sweep') {
    const rows = await db
      .prepare(
        'SELECT key,kind,listing_id,page,revision,unreferenced_at,mark_epoch,retry_at FROM catalog_artifacts WHERE key>? ORDER BY key LIMIT 100'
      )
      .bind(s.cursor)
      .all<Artifact>();
    const eligible = rows.results
      .filter(
        (r) =>
          r.mark_epoch !== s.epoch &&
          r.unreferenced_at != null &&
          r.unreferenced_at <= cutoff &&
          (!r.retry_at || r.retry_at <= now)
      )
      .slice(0, GC_DELETE_BATCH);
    const kvDelete = kv?.delete?.bind(kv);
    if (eligible.length > 0 && !kvDelete) {
      console.warn(JSON.stringify({ event: 'catalog_gc_delete_unavailable' }));
      s.phase = 'idle';
      s.next_run_at = new Date(nowMs + 5 * 60_000).toISOString();
      await db.batch([...guard(db, s, lease), save(db, s)]);
      return false;
    }
    const boundary = eligible.at(-1)?.key ?? rows.results.at(-1)?.key ?? s.cursor;
    const prefix = rows.results
      .filter((r) => r.key <= boundary && r.mark_epoch !== s.epoch)
      .map((r) => r.key);
    await db.batch([
      ...guard(db, s, lease),
      db
        .prepare(
          'UPDATE catalog_artifacts SET unreferenced_at=COALESCE(unreferenced_at,?) WHERE key IN (SELECT value FROM json_each(?)) AND mark_epoch<>?'
        )
        .bind(now, JSON.stringify(prefix), s.epoch),
    ]);
    if (eligible.length > 0 && kvDelete) {
      const [, , claim] = await db.batch<{ key: string }>([
        ...guard(db, s, lease),
        db
          .prepare(
            'UPDATE catalog_artifacts SET deletion_pending=1 WHERE key IN (SELECT value FROM json_each(?)) AND mark_epoch<>? AND unreferenced_at<=? RETURNING key'
          )
          .bind(JSON.stringify(eligible.map((r) => r.key)), s.epoch, cutoff),
      ]);
      const claimedKeys = new Set((claim?.results ?? []).map((r) => r.key));
      const deleted: Artifact[] = [];
      const failed: string[] = [];
      // The binding has no bulk delete, so keys are removed one at a time.
      for (const artifact of eligible.filter((r) => claimedKeys.has(r.key))) {
        try {
          await kvDelete(artifact.key);
          deleted.push(artifact);
        } catch (error) {
          if (error instanceof BudgetExhausted) throw error;
          console.warn(
            JSON.stringify({
              event: 'catalog_gc_delete_failed',
              errorType: error instanceof Error ? error.name : 'unknown',
            })
          );
          failed.push(artifact.key);
        }
      }
      const ofKind = (kind: string) => deleted.filter((r) => r.kind === kind);
      await db.batch([
        ...guard(db, s, lease),
        db
          .prepare(
            'UPDATE catalog_artifacts SET retry_at=?,failure=? WHERE key IN (SELECT value FROM json_each(?))'
          )
          .bind(
            new Date(nowMs + 5 * 60_000).toISOString(),
            'KV deletion failed',
            JSON.stringify(failed)
          ),
        db
          .prepare('DELETE FROM catalog_documents WHERE key IN (SELECT value FROM json_each(?))')
          .bind(JSON.stringify(ofKind('document').map((r) => r.key))),
        db
          .prepare('DELETE FROM catalog_ref_chunks WHERE hash IN (SELECT value FROM json_each(?))')
          .bind(JSON.stringify(ofKind('directory').map((r) => r.revision))),
        db
          .prepare(
            `DELETE FROM catalog_listing_page_revisions WHERE (listing_id,generation,page,revision) IN (
              SELECT r.listing_id,r.generation,r.page,r.revision FROM catalog_listing_page_revisions r
              JOIN json_each(?) j ON r.listing_id=json_extract(j.value,'$[0]') AND r.page=json_extract(j.value,'$[1]') AND r.revision=json_extract(j.value,'$[2]')
              LIMIT ${PAGE_REVISION_DELETE_LIMIT})`
          )
          .bind(JSON.stringify(ofKind('page').map((r) => [r.listing_id, r.page, r.revision]))),
        db
          .prepare(
            `DELETE FROM catalog_artifacts WHERE key IN (SELECT value FROM json_each(?)) AND NOT EXISTS(
              SELECT 1 FROM catalog_listing_page_revisions r WHERE catalog_artifacts.kind='page' AND r.listing_id=catalog_artifacts.listing_id AND r.page=catalog_artifacts.page AND r.revision=catalog_artifacts.revision)`
          )
          .bind(JSON.stringify(deleted.map((r) => r.key))),
      ]);
      // A page whose revision rows exceed one statement's limit stays
      // claimed; the sweep resumes at the same cursor to finish it.
      const pending = await db
        .prepare(
          'SELECT 1 FROM catalog_artifacts WHERE key IN (SELECT value FROM json_each(?)) LIMIT 1'
        )
        .bind(JSON.stringify(deleted.map((r) => r.key)))
        .first();
      if (pending) return false;
    }
    s.cursor = boundary;
    if (rows.results.length < PAGE && eligible.length === 0) {
      s.phase = 'prune';
      s.step = 0;
      s.cursor = '';
    }
    await db.batch([...guard(db, s, lease), save(db, s)]);
    return false;
  }
  if (s.phase === 'prune') {
    // History rows remain roots until their own seven-day window expires.
    const statements = [
      db
        .prepare(
          `DELETE FROM catalog_ref_documents WHERE (ref_key,publication_seq,document_key) IN (SELECT d.ref_key,d.publication_seq,d.document_key FROM catalog_ref_documents d WHERE d.retired_at<=? AND NOT EXISTS(SELECT 1 FROM catalog_ref_state r WHERE r.ref_key=d.ref_key AND r.committed_seq=d.publication_seq) ORDER BY d.retired_at LIMIT 100)`
        )
        .bind(cutoff),
      db
        .prepare(
          `DELETE FROM catalog_listing_ref_history WHERE (listing_id,generation,publication_seq) IN (SELECT h.listing_id,h.generation,h.publication_seq FROM catalog_listing_ref_history h WHERE h.retired_at<=? AND NOT EXISTS(SELECT 1 FROM catalog_ref_state r WHERE r.ref_key='listing:'||h.listing_id AND r.committed_seq=h.publication_seq) ORDER BY h.retired_at LIMIT 100)`
        )
        .bind(cutoff),
    ];
    const result = await db.batch([...guard(db, s, lease), ...statements]);
    if (result.slice(2).some((r) => (r.meta.changes ?? 0) === PAGE)) return false;
    const build = await db
      .prepare(
        `SELECT id FROM catalog_builds WHERE state IN ${TERMINAL} AND updated_at<? ORDER BY updated_at,id LIMIT 1`
      )
      .bind(cutoff)
      .first<{ id: string }>();
    if (build) {
      await db.batch([
        ...guard(db, s, lease),
        db
          .prepare(
            'DELETE FROM catalog_build_pages WHERE (build_id,listing_id,page) IN (SELECT build_id,listing_id,page FROM catalog_build_pages WHERE build_id=? LIMIT 100)'
          )
          .bind(build.id),
        db
          .prepare(
            'DELETE FROM catalog_build_listings WHERE (build_id,listing_id) IN (SELECT build_id,listing_id FROM catalog_build_listings WHERE build_id=? LIMIT 100)'
          )
          .bind(build.id),
        db
          .prepare(
            `DELETE FROM catalog_builds WHERE id=? AND state IN ${TERMINAL} AND NOT EXISTS(SELECT 1 FROM catalog_build_pages WHERE build_id=?) AND NOT EXISTS(SELECT 1 FROM catalog_build_listings WHERE build_id=?)`
          )
          .bind(build.id, build.id, build.id),
      ]);
      return false;
    }
    const old = await db
      .prepare(
        `SELECT l.listing_id,l.generation,l.listing_id<>'${ALL_LISTING}' AND NOT EXISTS(SELECT 1 FROM collections c WHERE c.id=l.listing_id) AND NOT EXISTS(SELECT 1 FROM catalog_listings a WHERE a.listing_id=l.listing_id AND a.active=1) AS retired FROM catalog_listings l WHERE l.active=0 AND l.updated_at<? AND NOT EXISTS(SELECT 1 FROM catalog_listing_ref_history h WHERE h.listing_id=l.listing_id AND h.generation=l.generation) ORDER BY l.updated_at,l.listing_id,l.generation LIMIT 1`
      )
      .bind(cutoff)
      .first<{ listing_id: string; generation: number; retired: number }>();
    if (old) {
      // A retired listing keeps its last generation row until its membership is gone.
      await db.batch([
        ...guard(db, s, lease),
        db
          .prepare(
            'DELETE FROM catalog_page_products WHERE (product_id,listing_id,generation,page) IN (SELECT product_id,listing_id,generation,page FROM catalog_page_products WHERE listing_id=? AND generation=? LIMIT 100)'
          )
          .bind(old.listing_id, old.generation),
        ...(old.retired
          ? [
              db
                .prepare(
                  'DELETE FROM catalog_membership WHERE (listing_id,product_id) IN (SELECT listing_id,product_id FROM catalog_membership WHERE listing_id=? LIMIT 100)'
                )
                .bind(old.listing_id),
            ]
          : []),
        db
          .prepare(
            'DELETE FROM catalog_listings WHERE listing_id=? AND generation=? AND active=0 AND NOT EXISTS(SELECT 1 FROM catalog_page_products WHERE listing_id=? AND generation=?) AND NOT EXISTS(SELECT 1 FROM catalog_membership WHERE listing_id=? AND ?)'
          )
          .bind(
            old.listing_id,
            old.generation,
            old.listing_id,
            old.generation,
            old.listing_id,
            old.retired
          ),
      ]);
      return false;
    }
    const retry = await db
      .prepare('SELECT MIN(retry_at) AS at FROM catalog_artifacts WHERE retry_at IS NOT NULL')
      .first<{ at: string | null }>();
    s.phase = 'idle';
    s.cursor = '';
    s.next_run_at = retry?.at ?? new Date(nowMs + 24 * 60 * 60_000).toISOString();
    await db.batch([...guard(db, s, lease), save(db, s)]);
    return false;
  }
  throw new Error('Invalid catalog GC checkpoint');
}

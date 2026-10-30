import * as z from 'zod';
import { type CatalogLease, leaseGuardStatement } from './catalog-exec';
import {
  directoryKey,
  listingPageKey,
  listingRefKey,
  productSlugKey,
  LAYOUT_REF_KEY,
} from './catalog-models';

type Kv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};
const cursorSchema = z.object({
  stage: z.number(),
  key: z.string(),
  pagePosition: z.tuple([z.string(), z.number(), z.number(), z.string()]).optional(),
});
const productIdentitySchema = z.object({ id: z.string(), slug: z.string(), revision: z.string() });

/** Replay durable artifacts, never source tables or a new publication. */
export async function repairCatalogUnit(
  db: D1Database,
  kv: Kv,
  lease: CatalogLease
): Promise<boolean> {
  let build = await db
    .prepare(
      "SELECT id,state_json FROM catalog_builds WHERE kind='replica' AND state='building' LIMIT 1"
    )
    .first<{ id: string; state_json: string }>();
  if (!build) {
    build = { id: 'catalog-replica-verification', state_json: '{"stage":0,"key":""}' };
    await db
      .prepare(
        "INSERT INTO catalog_builds(id,kind,state,phase,state_json,created_at,updated_at) VALUES(?,'replica','building','replicas',?,datetime('now'),datetime('now')) ON CONFLICT(id) DO UPDATE SET state='building',phase='replicas',state_json=excluded.state_json,updated_at=excluded.updated_at"
      )
      .bind(build.id, build.state_json)
      .run();
  }
  const cursor = cursorSchema.parse(JSON.parse(build.state_json));
  const tables = [
    'catalog_documents',
    'catalog_ref_chunks',
    'catalog_listing_page_revisions',
  ] as const;
  const table = tables[cursor.stage];
  if (table) {
    const keyColumn =
      cursor.stage === 0
        ? 'key'
        : cursor.stage === 1
          ? 'hash'
          : "listing_id||':'||generation||':'||page||':'||revision";
    const projection =
      cursor.stage === 0
        ? 'key,kind,revision'
        : cursor.stage === 1
          ? 'hash'
          : 'listing_id,generation,page,revision';
    const ordering = cursor.stage === 2 ? 'listing_id,generation,page,revision' : keyColumn;
    const predicate =
      cursor.stage === 2 ? '(listing_id,generation,page,revision)>(?,?,?,?)' : `${keyColumn}>?`;
    const rows = await db
      .prepare(
        `WITH slice AS (SELECT ${keyColumn} AS cursor_key,${projection},payload_json,length(CAST(payload_json AS BLOB)) AS payload_bytes FROM ${table} WHERE ${predicate} ORDER BY ${ordering} LIMIT 128), sized AS (SELECT *,SUM(payload_bytes) OVER (ORDER BY ${cursor.stage === 2 ? ordering : 'cursor_key'} ROWS UNBOUNDED PRECEDING) AS bytes_so_far FROM slice) SELECT cursor_key,${projection},payload_bytes,CASE WHEN bytes_so_far<=2097152 THEN payload_json ELSE NULL END AS payload_json FROM sized ORDER BY ${cursor.stage === 2 ? ordering : 'cursor_key'}`
      )
      .bind(...(cursor.stage === 2 ? (cursor.pagePosition ?? ['', 0, 0, '']) : [cursor.key]))
      .all<Record<string, unknown>>();
    const currentProducts =
      cursor.stage === 0
        ? await db
            .prepare(
              "SELECT product_id,doc_revision FROM catalog_cards WHERE product_id IN (SELECT json_extract(payload_json,'$.id') FROM catalog_documents WHERE key>? ORDER BY key LIMIT 128)"
            )
            .bind(cursor.key)
            .all<{ product_id: string; doc_revision: string }>()
        : null;
    const revisions = new Map(currentProducts?.results.map((r) => [r.product_id, r.doc_revision]));
    let overflow = false;
    for (const row of rows.results) {
      if (Number(row.payload_bytes) > 2 * 1024 * 1024)
        throw new Error('Catalog artifact exceeds bounded repair payload');
      if (row.payload_json == null) {
        overflow = true;
        break;
      }
      const key =
        cursor.stage === 0
          ? String(row.key)
          : cursor.stage === 1
            ? directoryKey(String(row.hash))
            : listingPageKey(String(row.listing_id), Number(row.page), String(row.revision));
      const payload = String(row.payload_json);
      // Large artifacts are replayed without holding an old KV copy as well.
      if (Number(row.payload_bytes) > 1024 * 1024 || (await kv.get(key)) !== payload)
        await kv.put(key, payload);
      if (cursor.stage === 0 && row.kind === 'product') {
        const doc = productIdentitySchema.parse(JSON.parse(payload));
        if (revisions.get(doc.id) === doc.revision) {
          const pointer = JSON.stringify({ id: doc.id, revision: doc.revision });
          const slugKey = productSlugKey(doc.slug);
          if ((await kv.get(slugKey)) !== pointer) await kv.put(slugKey, pointer);
        }
      }
      cursor.key = String(row.cursor_key);
      if (cursor.stage === 2)
        cursor.pagePosition = [
          String(row.listing_id),
          Number(row.generation),
          Number(row.page),
          String(row.revision),
        ];
    }
    if (!overflow && rows.results.length < 128) {
      cursor.stage++;
      cursor.key = '';
    }
  } else {
    const rows = await db
      .prepare(
        'SELECT ref_key,committed_seq,root_hash,pending_payload,last_write_at FROM catalog_ref_state WHERE ref_key>? ORDER BY ref_key LIMIT 4'
      )
      .bind(cursor.key)
      .all<{
        ref_key: string;
        committed_seq: number;
        root_hash: string | null;
        pending_payload: string | null;
        last_write_at: string | null;
      }>();
    for (const row of rows.results) {
      let payload = row.pending_payload;
      let key: string;
      if (row.ref_key.startsWith('listing:')) {
        const id = row.ref_key.slice(8);
        key = listingRefKey(id);
        const h = await db
          .prepare(
            `SELECT h.generation,h.page_size,h.total,h.page_count,h.root_hash,
              (SELECT rd.document_key FROM catalog_ref_documents rd JOIN catalog_documents d ON d.key=rd.document_key
               WHERE rd.ref_key=? AND rd.publication_seq=h.publication_seq AND d.kind='collection-meta' LIMIT 1) AS metadata_key
             FROM catalog_listing_ref_history h WHERE h.listing_id=? AND h.publication_seq=?`
          )
          .bind(row.ref_key, id, row.committed_seq)
          .first<{
            generation: number;
            page_size: number;
            total: number;
            page_count: number;
            root_hash: string;
            metadata_key: string | null;
          }>();
        if (!h) throw new Error('Committed listing history is missing');
        payload = JSON.stringify({
          listingId: id,
          generation: h.generation,
          publicationSeq: row.committed_seq,
          pageSize: h.page_size,
          total: h.total,
          pageCount: h.page_count,
          rootHash: h.root_hash,
          ...(h.metadata_key ? { metadataKey: h.metadata_key } : {}),
        });
      } else if (row.ref_key === 'layout') {
        key = LAYOUT_REF_KEY;
        payload ??= JSON.stringify({ revision: row.root_hash });
      } else {
        cursor.key = row.ref_key;
        continue;
      }
      if (payload && (await kv.get(key)) !== payload) {
        if (row.last_write_at && Date.now() - Date.parse(row.last_write_at) < 1100) return false;
        await kv.put(key, payload);
        await db.batch([
          leaseGuardStatement(db, lease),
          db
            .prepare(
              'UPDATE catalog_ref_state SET delivered_seq=?,pending_payload=NULL,last_write_at=? WHERE ref_key=? AND committed_seq=?'
            )
            .bind(row.committed_seq, new Date().toISOString(), row.ref_key, row.committed_seq),
        ]);
      }
      cursor.key = row.ref_key;
    }
    if (rows.results.length < 4) cursor.stage++;
  }
  const done = cursor.stage > tables.length;
  await db.batch([
    leaseGuardStatement(db, lease),
    db
      .prepare(
        "UPDATE catalog_builds SET state=?,state_json=?,updated_at=datetime('now') WHERE id=?"
      )
      .bind(done ? 'done' : 'building', JSON.stringify(cursor), build.id),
  ]);
  return done;
}

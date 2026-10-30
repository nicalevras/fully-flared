import { z } from 'zod';
import { listingRefKey, LAYOUT_REF_KEY } from './catalog-models';

const refDigestSchema = z.object({
  rootHash: z.string().optional(),
  revision: z.string().optional(),
});

/** The content hash a listing or layout reference points at; null for a missing or unreadable payload. */
function refDigest(payload: string | null): string | null {
  if (payload === null) return null;
  try {
    const parsed = refDigestSchema.safeParse(JSON.parse(payload));
    return parsed.success ? (parsed.data.rootHash ?? parsed.data.revision ?? null) : null;
  } catch {
    return null;
  }
}

export async function catalogWorkDue(db: D1Database) {
  return Boolean(
    await db
      .prepare(
        `SELECT 1 WHERE
    NOT EXISTS(SELECT 1 FROM catalog_listings WHERE listing_id='all' AND active=1)
    OR EXISTS(SELECT 1 FROM catalog_work INDEXED BY catalog_work_pending_idx WHERE processed_revision<target_revision AND (next_attempt_at IS NULL OR next_attempt_at<=?))
    OR EXISTS(SELECT 1 FROM catalog_builds WHERE state IN ('building','pending_delivery'))
    OR EXISTS(SELECT 1 FROM catalog_ref_state WHERE (pending_payload IS NOT NULL AND (delivery_retry_at IS NULL OR delivery_retry_at<=?)) OR verify_after<=?)
    OR EXISTS(SELECT 1 FROM posts WHERE status='scheduled' AND published_at<=?)`
      )
      .bind(
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString()
      )
      .first()
  );
}

export type FailingCatalogWork = {
  count: number;
  items: Array<{
    entity_type: string;
    entity_id: string;
    last_error: string;
    retry_count: number;
    next_attempt_at: string | null;
  }>;
};

/** Unpublished catalogue work whose last attempt failed, most recently retried first. */
export async function failingCatalogWork(db: D1Database): Promise<FailingCatalogWork> {
  const failing = 'last_error IS NOT NULL AND processed_revision<target_revision';
  const [count, items] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM catalog_work WHERE ${failing}`).first<{ n: number }>(),
    db
      .prepare(
        `SELECT entity_type,entity_id,last_error,retry_count,next_attempt_at FROM catalog_work WHERE ${failing} ORDER BY next_attempt_at DESC LIMIT 10`
      )
      .all<FailingCatalogWork['items'][number]>(),
  ]);
  return { count: count?.n ?? 0, items: items.results };
}

/** Verify only changed mutable references here. The daily replica sweep covers
 * immutable artifacts independently. Exact payloads never come from live source. */
export async function verifyChangedReferences(
  db: D1Database,
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> }
) {
  const at = new Date().toISOString();
  const rows = await db
    .prepare(
      'SELECT ref_key,committed_seq,expected_payload,last_write_at FROM catalog_ref_state WHERE verify_after<=? AND expected_payload IS NOT NULL ORDER BY verify_after LIMIT 4'
    )
    .bind(at)
    .all<{
      ref_key: string;
      committed_seq: number;
      expected_payload: string;
      last_write_at: string | null;
    }>();
  for (const row of rows.results) {
    const key =
      row.ref_key === 'layout'
        ? LAYOUT_REF_KEY
        : row.ref_key.startsWith('listing:')
          ? listingRefKey(row.ref_key.slice(8))
          : null;
    if (!key) throw Error('Unknown catalog reference');
    const actual = await kv.get(key);
    if (actual !== row.expected_payload) {
      if (row.last_write_at && Date.now() - Date.parse(row.last_write_at) < 1100) continue;
      console.warn(
        JSON.stringify({
          event: 'catalog_ref_mismatch',
          refKey: row.ref_key,
          committedSeq: row.committed_seq,
          expectedRootHash: refDigest(row.expected_payload),
          actualRootHash: refDigest(actual),
          ageMs: row.last_write_at ? Date.now() - Date.parse(row.last_write_at) : null,
        })
      );
      await kv.put(key, row.expected_payload);
      await db
        .prepare(
          'UPDATE catalog_ref_state SET last_write_at=?,verify_after=? WHERE ref_key=? AND committed_seq=?'
        )
        .bind(at, new Date(Date.now() + 60_000).toISOString(), row.ref_key, row.committed_seq)
        .run();
    } else
      await db
        .prepare(
          'UPDATE catalog_ref_state SET verified_seq=?,verify_after=NULL WHERE ref_key=? AND committed_seq=?'
        )
        .bind(row.committed_seq, row.ref_key, row.committed_seq)
        .run();
  }
  return rows.results.length;
}

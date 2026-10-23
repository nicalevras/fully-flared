import { listingRefKey, LAYOUT_REF_KEY } from './catalog-models';

export async function catalogWorkDue(db: D1Database) {
  return Boolean(
    await db
      .prepare(
        `SELECT 1 WHERE
    NOT EXISTS(SELECT 1 FROM catalog_listings WHERE listing_id='all' AND active=1)
    OR EXISTS(SELECT 1 FROM catalog_work WHERE processed_revision<target_revision AND (next_attempt_at IS NULL OR next_attempt_at<=?))
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

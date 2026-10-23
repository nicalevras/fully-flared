export async function reconciliationCursors(db: D1Database, names?: string[]) {
  const rows = await db
    .prepare(
      `SELECT name,cursor FROM reconciliation_cursors ${names?.length ? `WHERE name IN (${names.map(() => '?').join(',')})` : ''}`
    )
    .bind(...(names ?? []))
    .all<{ name: string; cursor: string }>();
  return new Map(rows.results.map((row) => [row.name, row.cursor]));
}
/** Concurrent passes may repeat work, but cannot rewind a cursor another pass advanced. */
export type CursorClaim = { runId: string; token: string };
export async function advanceCursor(
  db: D1Database,
  name: string,
  previous: string,
  next: string,
  claim?: CursorClaim
) {
  const owned = claim
    ? `EXISTS(SELECT 1 FROM maintenance_runs WHERE id=? AND claim_token=? AND state='running' AND claim_expires_at>?)`
    : '1';
  const args = claim ? [claim.runId, claim.token, new Date().toISOString()] : [];
  const result = await db
    .prepare(
      `INSERT INTO reconciliation_cursors(name,cursor,updated_at) SELECT ?,?,? WHERE ${owned} ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at WHERE reconciliation_cursors.cursor=? AND ${owned}`
    )
    .bind(name, next, new Date().toISOString(), ...args, previous, ...args)
    .run();
  if (claim && !result.meta.changes) throw new Error('Reconciliation cursor claim lost');
}

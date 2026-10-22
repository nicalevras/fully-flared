export async function reconciliationCursors(db: D1Database) {
  const rows = await db
    .prepare('SELECT name,cursor FROM reconciliation_cursors')
    .all<{ name: string; cursor: string }>();
  return new Map(rows.results.map((row) => [row.name, row.cursor]));
}
/** Concurrent passes may repeat work, but cannot rewind a cursor another pass advanced. */
export async function advanceCursor(db: D1Database, name: string, previous: string, next: string) {
  await db
    .prepare(
      `INSERT INTO reconciliation_cursors(name,cursor,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at WHERE reconciliation_cursors.cursor=?`
    )
    .bind(name, next, new Date().toISOString(), previous)
    .run();
}

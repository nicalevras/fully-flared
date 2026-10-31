export function auditStatement(
  db: D1Database,
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  details?: unknown,
  options: { id?: string; condition?: { sql: string; values: unknown[] } } = {}
) {
  return db
    .prepare(
      `INSERT INTO audit_log (id,actor_user_id,action,entity_type,entity_id,details_json,created_at)
       SELECT ?,?,?,?,?,?,? ${options.condition ? `WHERE ${options.condition.sql}` : ''}
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(
      options.id ?? crypto.randomUUID(),
      actorId,
      action,
      entityType,
      entityId,
      details === undefined ? null : JSON.stringify(details),
      new Date().toISOString(),
      ...(options.condition?.values ?? [])
    );
}

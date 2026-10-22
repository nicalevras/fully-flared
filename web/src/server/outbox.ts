export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

/** A deterministic outbox identity is the notification deduplication constraint. */
export function emailStatement(
  db: D1Database,
  identity: string,
  msg: EmailMessage,
  gate?: { sql: string; values: (string | number | null)[] }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox(id,type,payload_json,created_at) SELECT ?,'email.send',?,? ${gate ? `WHERE ${gate.sql}` : ''} ON CONFLICT(id) DO NOTHING`
    )
    .bind(identity, JSON.stringify(msg), new Date().toISOString(), ...(gate?.values ?? []));
}

export async function operationalRecipients(db: D1Database): Promise<string[]> {
  const configured = await db
    .prepare("SELECT value FROM settings WHERE key='operational_alert_email'")
    .first<{ value: string }>();
  if (configured?.value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configured.value))
    return [configured.value];
  const owners = await db
    .prepare("SELECT email FROM user WHERE role='owner' AND email_verified=1 AND banned=0")
    .all<{ email: string }>();
  return owners.results.map((o) => o.email);
}

/** Commit durable notifications first; queue failures leave rows for the cron drain. */
export async function commitWithEmails(
  db: D1Database,
  statements: D1PreparedStatement[],
  identities: string[]
) {
  const result = await db.batch(statements);
  const ids = [...new Set(identities)];
  for (let offset = 0; offset < ids.length; offset += 90) {
    const page = ids.slice(offset, offset + 90);
    try {
      const rows = await db
        .prepare(
          `SELECT id FROM outbox WHERE id IN (${page.map(() => '?').join(',')}) AND status IN ('pending','failed') AND attempts<3 AND (retry_after IS NULL OR retry_after<=?)`
        )
        .bind(...page, new Date().toISOString())
        .all<{ id: string }>();
      if (!rows.results.length) continue;
      const { enqueueJob } = await import('./email.ts');
      await Promise.all(
        rows.results.map((row) => enqueueJob({ type: 'email.send', outboxId: row.id }))
      );
    } catch {
      console.error(JSON.stringify({ event: 'outbox_enqueue_unavailable' }));
    }
  }
  return result;
}

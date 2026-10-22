import type { EmailMessage } from './outbox';
export {
  emailStatement,
  commitWithEmails,
  operationalRecipients,
  type EmailMessage,
} from './outbox';
import { and, asc, eq, lt, or, sql } from 'drizzle-orm';
import { nextRetryIso } from './retry';
import { getDb } from '../db/client';
import { outbox } from '../db/schema';
import { getSettings } from './settings';
import { emailMessageSchema, type JobMessage } from '../schemas/queue';

export type { JobMessage } from '../schemas/queue';

// Transactional email via Cloudflare Email Service (send_email binding).
// Queue/outbox callers enqueue and the consumer sends.

export async function enqueueJob(job: JobMessage): Promise<boolean> {
  try {
    const { workerEnv } = await import('./env');
    // Separated queues (Phase 5): financial work, notifications and
    // catalog publication scale and fail independently, so a burst in
    // one cannot delay the others.
    const queue =
      job.type === 'webhook.process'
        ? workerEnv.JOBS
        : job.type === 'catalog.rebuild'
          ? workerEnv.CATALOG_JOBS
          : workerEnv.NOTIFICATIONS;
    if (!queue) return false;
    await queue.send(job);
    return true;
  } catch (err) {
    // The durable record (outbox/inbox) remains the fallback, but a broken
    // queue binding is an operations error and must be visible in logs.
    console.error(
      JSON.stringify({
        event: 'queue_enqueue_failed',
        type: job.type,
        error: err instanceof Error ? err.message : 'unknown',
      })
    );
    return false;
  }
}

export async function queueEmail(db: D1Database, msg: EmailMessage): Promise<string> {
  const outboxId = crypto.randomUUID();
  await getDb(db)
    .insert(outbox)
    .values({
      id: outboxId,
      type: 'email.send',
      payloadJson: JSON.stringify(msg),
      createdAt: new Date().toISOString(),
    });
  // Fast path through the Queue; the cron drain is the durability fallback.
  await enqueueJob({ type: 'email.send', outboxId });
  return outboxId;
}

function parseOutboxPayload(json: string): EmailMessage | null {
  try {
    const parsed = emailMessageSchema.safeParse(JSON.parse(json));
    return parsed.success ? (parsed.data as EmailMessage) : null;
  } catch {
    return null;
  }
}
export async function processOutboxRow(db: D1Database, outboxId: string): Promise<boolean> {
  const d = getDb(db);
  // Claim first with a conditional update: the queue consumer and the cron
  // drain can race for the same row, but only the claim winner may send.
  const claimNow = new Date().toISOString();
  const staleSendingBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  // Normal claim: pending, or failed under the attempt cap. The claim stamps
  // claimed_at so a second worker can tell a live send from a dead one.
  let claim = await d
    .update(outbox)
    .set({ status: 'sending', claimedAt: claimNow })
    .where(
      and(
        eq(outbox.id, outboxId),
        lt(outbox.attempts, 3),
        or(sql`${outbox.retryAfter} IS NULL`, sql`${outbox.retryAfter} <= ${claimNow}`),
        or(eq(outbox.status, 'pending'), eq(outbox.status, 'failed'))
      )
    )
    .run();
  if ((claim.meta.changes ?? 0) === 0) {
    // Recovery claim: a worker that died mid-send leaves the row in
    // 'sending'. Only a claim older than 10 minutes is stale — keyed on
    // claimed_at, never created_at, so a retried old row that is actively
    // being sent cannot be claimed twice. The reclaim itself counts as an
    // attempt, so a crash loop still stops at the cap. The conditional
    // update is atomic: after the winner restamps claimed_at, a loser's
    // stale predicate no longer matches.
    claim = await d
      .update(outbox)
      .set({ status: 'sending', claimedAt: claimNow, attempts: sql`${outbox.attempts} + 1` })
      .where(
        and(
          eq(outbox.id, outboxId),
          eq(outbox.status, 'sending'),
          lt(outbox.claimedAt, staleSendingBefore),
          lt(outbox.attempts, 3)
        )
      )
      .run();
  }
  if ((claim.meta.changes ?? 0) === 0) return false;
  const row = await d.query.outbox.findFirst({ where: eq(outbox.id, outboxId) });
  if (!row) return false;
  try {
    if (row.type === 'email.send') {
      const msg = parseOutboxPayload(row.payloadJson);
      if (!msg) throw new Error('Invalid outbox email payload');
      await sendEmail(db, msg);
    }
    await d
      .update(outbox)
      .set({ status: 'sent', sentAt: new Date().toISOString() })
      .where(
        and(eq(outbox.id, row.id), eq(outbox.status, 'sending'), eq(outbox.claimedAt, claimNow))
      );
    return true;
  } catch {
    await d
      .update(outbox)
      .set({
        status: 'failed',
        attempts: sql`${outbox.attempts} + 1`,
        retryAfter: nextRetryIso(row.attempts + 1),
      })
      .where(
        and(eq(outbox.id, row.id), eq(outbox.status, 'sending'), eq(outbox.claimedAt, claimNow))
      );
    throw new Error(`Outbox row ${row.id} failed`);
  }
}

/** Claim an abandoned-checkout reminder and create its outbox row in one
 *  batch: the mark and the queued email can never drift apart, and a second
 *  cron/queue pass cannot send a duplicate reminder for the same order.
 *  The claim rechecks status/payment at claim time, so an order already
 *  paid when the claim executes creates no reminder. (Payment arriving
 *  after the email is queued is outside this guarantee.) */
export async function queueAbandonedReminder(
  db: D1Database,
  order: { id: string; number: string; customer_email: string }
): Promise<boolean> {
  const outboxId = `abandoned-${order.id}`;
  const now = new Date().toISOString();
  const payload: EmailMessage = {
    to: order.customer_email,
    subject: `Your order ${order.number} is waiting`,
    text: `You left an order unfinished (${order.number}). Your items were held for a short time; complete checkout soon if you still want them.`,
    html: `<p>You left an order unfinished (<strong>${order.number}</strong>).</p><p>Your items were held for a short time; complete checkout soon if you still want them.</p>`,
  };
  const results = await db.batch([
    db
      .prepare(
        "UPDATE orders SET abandoned_reminded_at = ? WHERE id = ? AND abandoned_reminded_at IS NULL AND status = 'canceled' AND payment_status = 'unpaid'"
      )
      .bind(now, order.id),
    db
      .prepare(
        `INSERT INTO outbox (id, type, payload_json, created_at)
         SELECT ?, 'email.send', ?, ? WHERE (SELECT changes()) > 0`
      )
      .bind(outboxId, JSON.stringify(payload), now),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) return false;
  await enqueueJob({ type: 'email.send', outboxId });
  return true;
}

export async function sendEmail(db: D1Database, msg: EmailMessage) {
  const { workerEnv } = await import('./env');
  const settings = await getSettings(db);
  const binding = workerEnv.EMAIL;
  if (!binding) throw new Error('EMAIL binding (Cloudflare Email Service) is not configured');
  await binding.send({
    to: msg.to,
    from: { email: settings.emailFromAddress, name: settings.emailFromName },
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
}

export async function drainOutbox(db: D1Database, limit = 25): Promise<number> {
  const nowIso = new Date().toISOString();
  const staleSendingBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  const rows = await getDb(db)
    .select({ id: outbox.id })
    .from(outbox)
    .where(
      and(
        lt(outbox.attempts, 3),
        or(sql`${outbox.retryAfter} IS NULL`, sql`${outbox.retryAfter}<=${nowIso}`),
        or(
          eq(outbox.status, 'pending'),
          and(
            eq(outbox.status, 'failed'),
            lt(outbox.attempts, 3),
            or(sql`${outbox.retryAfter} IS NULL`, lt(outbox.retryAfter, nowIso))
          ),
          and(
            eq(outbox.status, 'sending'),
            lt(outbox.claimedAt, staleSendingBefore),
            lt(outbox.attempts, 3)
          )
        )
      )
    )
    .orderBy(asc(outbox.createdAt))
    .limit(limit);
  let sent = 0;
  for (const row of rows) {
    try {
      if (await processOutboxRow(db, row.id)) sent++;
    } catch {
      // processOutboxRow already recorded the failure; the next drain retries.
      console.warn(JSON.stringify({ event: 'outbox_drain_failed' }));
    }
  }
  return sent;
}

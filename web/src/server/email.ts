import type { EmailMessage } from './outbox';
export {
  emailStatement,
  commitWithEmails,
  operationalRecipients,
  type EmailMessage,
} from './outbox';
import { nextRetryIso } from './retry';
import {
  commitWithEmails,
  emailStatement,
  MAX_EMAIL_ATTEMPTS,
  OUTBOX_ALERT_PREFIX,
  operationalRecipients,
} from './outbox';
import { getDb } from '../db/client';
import { outbox } from '../db/schema';
import { getSettings } from './settings';
import {
  customerDeletionSchema,
  emailMessageSchema,
  outboxJobSchema,
  type JobMessage,
  type OutboxJobMessage,
} from '../schemas/queue';
import type { PaymentProvider } from './payments';
import { outboxDue, type RecoveryContext } from './recovery-eligibility';

export type { JobMessage } from '../schemas/queue';

// Transactional email via Cloudflare Email Service (send_email binding).
// Queue/outbox callers enqueue and the consumer sends.

export async function enqueueJob(
  job: JobMessage,
  options?: { delaySeconds: number }
): Promise<boolean> {
  try {
    // Maintenance routing requires the durable run's task, not just its message type.
    if (job.type === 'maintenance.run') throw new Error('Use task-aware maintenance dispatch');
    const { workerEnv } = await import('./env');
    // Separated queues (Phase 5): financial work, notifications and
    // catalog publication scale and fail independently, so a burst in
    // one cannot delay the others.
    const queue =
      job.type === 'webhook.process' || job.type === 'checkout.recover'
        ? workerEnv.JOBS
        : job.type === 'catalog.rebuild'
          ? workerEnv.CATALOG_JOBS
          : workerEnv.NOTIFICATIONS;
    if (!queue) return false;
    await queue.send(job, options);
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
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
type OutboxJob = {
  type: OutboxJobMessage['type'];
  run(payloadJson: string): Promise<void | 'canceled'>;
  alert(rowId: string): Omit<EmailMessage, 'to'>;
};

export function processOutboxRow(db: D1Database, outboxId: string): Promise<boolean> {
  return processOutbox(db, outboxId, {
    type: 'email.send',
    async run(payloadJson) {
      const msg = parseOutboxPayload(payloadJson);
      if (!msg) throw new Error('Invalid outbox email payload');
      await sendEmail(db, msg);
    },
    alert: (rowId) => ({
      subject: 'Store email delivery failed permanently',
      text: `Outbox email ${rowId} failed ${MAX_EMAIL_ATTEMPTS} times and will not be retried. Check the email provider.`,
      html: `<p>Outbox email ${rowId} failed ${MAX_EMAIL_ATTEMPTS} times and will not be retried. Check the email provider.</p>`,
    }),
  });
}

export function processCustomerDeletion(
  db: D1Database,
  outboxId: string,
  provider: Pick<PaymentProvider, 'deleteCustomer'> | undefined
): Promise<boolean> {
  return processOutbox(db, outboxId, {
    type: 'stripe.customer.delete',
    async run(payloadJson) {
      if (!provider?.deleteCustomer) throw new Error('Payment provider unavailable');
      const { customerId } = customerDeletionSchema.parse(JSON.parse(payloadJson));
      const retained = await db
        .prepare(
          `SELECT 1 FROM order_stripe_customers c JOIN orders o ON o.id=c.order_id
         WHERE c.customer_id=? AND o.privacy_deleted_at IS NULL LIMIT 1`
        )
        .bind(customerId)
        .first();
      if (retained) return 'canceled';
      await provider.deleteCustomer(customerId);
    },
    alert: (rowId) => ({
      subject: 'Stripe customer deletion failed permanently',
      text: `Outbox job ${rowId} could not delete a Stripe Customer after ${MAX_EMAIL_ATTEMPTS} attempts. Delete the Customer named in the job id in the Stripe Dashboard.`,
      html: `<p>Outbox job ${rowId} could not delete a Stripe Customer after ${MAX_EMAIL_ATTEMPTS} attempts. Delete the Customer named in the job id in the Stripe Dashboard.</p>`,
    }),
  });
}

type ClaimedOutbox = {
  id: string;
  payload_json: string;
  status: string;
  attempts: number;
  claimed_at: string | null;
  created_at: string;
};

async function failOutbox(db: D1Database, row: ClaimedOutbox, job: OutboxJob) {
  const exhausted = row.attempts >= MAX_EMAIL_ATTEMPTS && !row.id.startsWith(OUTBOX_ALERT_PREFIX);
  const alerts = (exhausted ? await operationalRecipients(db) : []).map((to) => ({
    to,
    id: `${OUTBOX_ALERT_PREFIX}${row.id}-${to}`,
  }));
  await commitWithEmails(
    db,
    [
      db
        .prepare(
          "UPDATE outbox SET status='failed',retry_after=? WHERE id=? AND status='sending' AND claimed_at IS ? AND attempts=?"
        )
        .bind(nextRetryIso(row.attempts), row.id, row.claimed_at, row.attempts),
      ...alerts.map(({ to, id }) =>
        emailStatement(
          db,
          id,
          { to, ...job.alert(row.id) },
          {
            sql: `EXISTS(SELECT 1 FROM outbox WHERE id=? AND status='failed' AND attempts>=${MAX_EMAIL_ATTEMPTS} AND claimed_at IS ?)`,
            values: [row.id, row.claimed_at],
          }
        )
      ),
    ],
    alerts.map(({ id }) => id)
  );
}

async function processOutbox(db: D1Database, outboxId: string, job: OutboxJob): Promise<boolean> {
  const claimNow = new Date().toISOString();
  const staleSendingBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  const claim = await db
    .prepare(
      `UPDATE outbox SET status='sending',claimed_at=?,attempts=attempts+1
     WHERE id=? AND type=? AND attempts<${MAX_EMAIL_ATTEMPTS} AND (
       (status IN ('pending','failed') AND (retry_after IS NULL OR retry_after<=?))
       OR (status='sending' AND COALESCE(claimed_at,created_at)<?))`
    )
    .bind(claimNow, outboxId, job.type, claimNow, staleSendingBefore)
    .run();
  const row = await db
    .prepare(
      'SELECT id,payload_json,status,attempts,claimed_at,created_at FROM outbox WHERE id=? AND type=?'
    )
    .bind(outboxId, job.type)
    .first<ClaimedOutbox>();
  if (!row) return false;
  if (!(claim.meta.changes ?? 0)) {
    if (
      row.status === 'sending' &&
      row.attempts >= MAX_EMAIL_ATTEMPTS &&
      (row.claimed_at ?? row.created_at) < staleSendingBefore
    )
      await failOutbox(db, row, job);
    return false;
  }
  if (row.status !== 'sending' || row.claimed_at !== claimNow) return false;
  try {
    const outcome = await job.run(row.payload_json);
    await db
      .prepare(
        "UPDATE outbox SET status=?,sent_at=?,payload_json='{}' WHERE id=? AND status='sending' AND claimed_at=?"
      )
      .bind(
        outcome === 'canceled' ? 'canceled' : 'sent',
        outcome === 'canceled' ? null : new Date().toISOString(),
        row.id,
        claimNow
      )
      .run();
    return true;
  } catch (error) {
    await failOutbox(db, row, job);
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
    console.warn(JSON.stringify({ event: 'outbox_delivery_failed', outboxId: row.id, code }));
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
    text: `You left an order unfinished (${order.number}). Return to the store if you still want these items. Availability and prices are checked again at checkout.`,
    html: `<p>You left an order unfinished (<strong>${order.number}</strong>).</p><p>Return to the store if you still want these items. Availability and prices are checked again at checkout.</p>`,
  };
  const results = await db.batch([
    db
      .prepare(
        "UPDATE orders SET abandoned_reminded_at = ? WHERE id = ? AND abandoned_reminded_at IS NULL AND status = 'canceled' AND payment_status = 'unpaid' AND reminder_consent=1 AND reminder_suppressed_at IS NULL AND COALESCE((SELECT value FROM settings WHERE key='abandoned_reminders_enabled'),'0')='1'"
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

export type OutboxRecoveryCursor = { createdAt: string; id: string };

/** Queue one bounded window; delivery and send claims belong to NOTIFICATIONS. */
export async function enqueueOutboxRecoveryPage(
  db: D1Database,
  context: RecoveryContext,
  cursor?: OutboxRecoveryCursor
) {
  const due = outboxDue(context);
  const rows = await db
    .prepare(
      `SELECT o.id,o.type,o.created_at FROM outbox o WHERE ${due.sql}
    ${cursor ? 'AND (o.created_at>? OR (o.created_at=? AND o.id>?))' : ''}
    ORDER BY o.created_at,o.id LIMIT 25`
    )
    .bind(...due.values, ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []))
    .all<{ id: string; type: string; created_at: string }>();
  let queued = 0,
    next = cursor;
  for (const row of rows.results) {
    const job = outboxJobSchema.safeParse({ type: row.type, outboxId: row.id });
    if (!job.success) {
      console.error(JSON.stringify({ event: 'outbox_unknown_type', outboxId: row.id }));
      next = { createdAt: row.created_at, id: row.id };
      continue;
    }
    if (!(await enqueueJob(job.data))) return { queued, cursor: next, done: false, retry: true };
    queued++;
    next = { createdAt: row.created_at, id: row.id };
  }
  return { queued, cursor: next, done: rows.results.length < 25, retry: false };
}

// Scheduled retention pruning. Runs from the Worker cron. Backups are
// handled by D1 Time Travel (see README "Backups and recovery"); there is
// no automated backup export.

import { MAX_EMAIL_ATTEMPTS } from './outbox';

export async function pruneRetention(
  db: D1Database,
  cutoffMs = Date.now()
): Promise<{
  webhookInbox: number;
  outbox: number;
  reservations: number;
  carts: number;
  checkoutIntents: number;
  rateLimit: number;
  sessions: number;
  verifications: number;
  failedOutbox: number;
  deadWebhookInbox: number;
}> {
  const ninetyDaysAgo = new Date(cutoffMs - 90 * 24 * 60 * 60_000).toISOString();
  const yearAgo = new Date(cutoffMs - 365 * 24 * 60 * 60_000).toISOString();
  const thirtyDaysAgo = new Date(cutoffMs - 30 * 24 * 60 * 60_000).toISOString();
  /* IP data has its own hourly bounded job. */
  const carts = await db
    .prepare(
      `DELETE FROM carts WHERE id IN (SELECT id FROM carts WHERE status IN ('open','expired','converted') AND expires_at < ? ORDER BY expires_at,id LIMIT 1000)`
    )
    .bind(new Date(cutoffMs).toISOString())
    .run();
  // Only cart_items references carts (ON DELETE CASCADE); orders has no
  // cart FK and reservations.cart_id is a loose text column, so expired
  // carts can be deleted without orphaning a foreign key.
  // Checkout intents hold frozen provider payloads (PII-bearing): drop
  // terminal attempts after 90 days and completed ones after a year.
  // Orders keep their own session/intent identifiers independently.
  const checkoutIntents = await db
    .prepare(
      `DELETE FROM checkout_intents WHERE id IN (SELECT id FROM checkout_intents WHERE payment_state IN ('finalized','canceled') AND ((state IN ('canceled','expired') AND created_at < ?) OR (state = 'ready' AND created_at < ?)) ORDER BY created_at,id LIMIT 1000)`
    )
    .bind(ninetyDaysAgo, yearAgo)
    .run();
  // Bounded pages, like carts/intents above: each run deletes at most
  // 1000 rows per table and the next cron run continues the backlog,
  // so a large backlog never becomes one long write.
  // Auth tables store epoch milliseconds. The longest rate-limit window is
  // 60s, so a day-old counter can never affect a decision.
  const [rateLimit, sessions, verifications, failedOutbox, deadWebhookInbox] = await Promise.all([
    db
      .prepare(
        'DELETE FROM rate_limit WHERE id IN (SELECT id FROM rate_limit WHERE last_request < ? LIMIT 1000)'
      )
      .bind(cutoffMs - 24 * 60 * 60_000)
      .run(),
    db
      .prepare(
        'DELETE FROM session WHERE id IN (SELECT id FROM session WHERE expires_at < ? LIMIT 1000)'
      )
      .bind(cutoffMs)
      .run(),
    db
      .prepare(
        'DELETE FROM verification WHERE id IN (SELECT id FROM verification WHERE expires_at < ? LIMIT 1000)'
      )
      .bind(cutoffMs)
      .run(),
    db
      .prepare(
        `DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE status = 'failed' AND attempts >= ${MAX_EMAIL_ATTEMPTS} AND created_at < ? ORDER BY created_at,id LIMIT 1000)`
      )
      .bind(thirtyDaysAgo)
      .run(),
    db
      .prepare(
        `DELETE FROM webhook_inbox WHERE id IN (SELECT id FROM webhook_inbox WHERE status = 'dead' AND received_at < ? ORDER BY received_at,id LIMIT 1000)`
      )
      .bind(ninetyDaysAgo)
      .run(),
  ]);
  if ((deadWebhookInbox.meta.changes ?? 0) > 0)
    console.warn(
      JSON.stringify({
        event: 'retention_dead_webhooks_deleted',
        count: deadWebhookInbox.meta.changes,
      })
    );
  const [webhookInbox, outbox, reservations] = await Promise.all([
    db
      .prepare(
        `DELETE FROM webhook_inbox WHERE id IN (SELECT id FROM webhook_inbox WHERE status = 'processed' AND COALESCE(processed_at, received_at) < ? ORDER BY COALESCE(processed_at, received_at),id LIMIT 1000)`
      )
      .bind(ninetyDaysAgo)
      .run(),
    db
      .prepare(
        `DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE status = 'sent' AND COALESCE(sent_at, created_at) < ? ORDER BY COALESCE(sent_at, created_at),id LIMIT 1000)`
      )
      .bind(ninetyDaysAgo)
      .run(),
    db
      .prepare(
        `DELETE FROM reservations WHERE id IN (SELECT id FROM reservations WHERE status = 'released' AND created_at < ? ORDER BY created_at,id LIMIT 1000)`
      )
      .bind(yearAgo)
      .run(),
  ]);
  return {
    webhookInbox: webhookInbox.meta.changes ?? 0,
    outbox: outbox.meta.changes ?? 0,
    reservations: reservations.meta.changes ?? 0,
    carts: carts.meta.changes ?? 0,
    checkoutIntents: checkoutIntents.meta.changes ?? 0,
    rateLimit: rateLimit.meta.changes ?? 0,
    sessions: sessions.meta.changes ?? 0,
    verifications: verifications.meta.changes ?? 0,
    failedOutbox: failedOutbox.meta.changes ?? 0,
    deadWebhookInbox: deadWebhookInbox.meta.changes ?? 0,
  };
}

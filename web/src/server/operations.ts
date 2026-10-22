// Scheduled retention pruning. Runs from the Worker cron. Backups are
// handled by D1 Time Travel (see README "Backups and recovery"); there is
// no automated backup export.

export async function pruneRetention(db: D1Database): Promise<{
  webhookInbox: number;
  outbox: number;
  reservations: number;
  carts: number;
  checkoutIntents: number;
}> {
  await db
    .prepare(
      'UPDATE orders SET customer_ip=NULL WHERE id IN (SELECT id FROM orders WHERE customer_ip IS NOT NULL AND created_at < ? ORDER BY created_at,id LIMIT 1000)'
    )
    .bind(new Date(Date.now() - 60 * 60_000).toISOString())
    .run();
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
  const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60_000).toISOString();
  // Only cart_items references carts (ON DELETE CASCADE); orders has no
  // cart FK and reservations.cart_id is a loose text column, so expired
  // carts can be deleted without orphaning a foreign key.
  const carts = await db
    .prepare(
      `DELETE FROM carts WHERE id IN (SELECT id FROM carts WHERE status IN ('open','expired','converted') AND expires_at < ? ORDER BY expires_at,id LIMIT 1000)`
    )
    .bind(new Date().toISOString())
    .run();
  // Checkout intents hold frozen provider payloads (PII-bearing): drop
  // terminal attempts after 90 days and completed ones after a year.
  // Orders keep their own session/intent identifiers independently.
  const checkoutIntents = await db
    .prepare(
      `DELETE FROM checkout_intents WHERE id IN (SELECT id FROM checkout_intents WHERE (state IN ('canceled','expired') AND created_at < ?) OR (state = 'ready' AND created_at < ?) ORDER BY created_at,id LIMIT 1000)`
    )
    .bind(ninetyDaysAgo, yearAgo)
    .run();
  // Bounded pages, like carts/intents above: each run deletes at most
  // 1000 rows per table and the next cron run continues the backlog,
  // so a large backlog never becomes one long write.
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
  };
}

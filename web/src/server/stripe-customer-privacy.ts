import type { PaymentProvider } from './payments';
import { enqueueJob } from './email';

export function registerCustomerOperation(
  db: D1Database,
  attemptId: string,
  creationDeadline: string
): D1PreparedStatement {
  const now = new Date().toISOString();
  return db
    .prepare(
      `INSERT INTO stripe_customer_operations(attempt_id,order_id,created_at,creation_deadline_at,next_reconcile_at)
     SELECT ci.id,ci.order_id,?, ?,? FROM checkout_intents ci JOIN orders o ON o.id=ci.order_id
     WHERE ci.id=? AND o.privacy_deleted_at IS NULL
     ON CONFLICT(attempt_id) DO NOTHING`
    )
    .bind(now, creationDeadline, now, attemptId);
}

export function customerDeletionStatement(
  db: D1Database,
  scope: { sql: string; values: (string | number)[] }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox(id,type,payload_json,created_at)
     SELECT DISTINCT 'stripe-customer-delete-'||c.customer_id,'stripe.customer.delete',json_object('customerId',c.customer_id),?
     FROM order_stripe_customers c JOIN orders o ON o.id=c.order_id
     WHERE o.privacy_deleted_at IS NOT NULL AND (${scope.sql})
       AND NOT EXISTS(SELECT 1 FROM order_stripe_customers retained JOIN orders kept ON kept.id=retained.order_id
         WHERE retained.customer_id=c.customer_id AND kept.privacy_deleted_at IS NULL)
     ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,retry_after=NULL,claimed_at=NULL,payload_json=excluded.payload_json
       WHERE outbox.status='canceled'
     RETURNING id`
    )
    .bind(new Date().toISOString(), ...scope.values);
}

/** Provider observations survive checkout fencing; commerce transitions remain fenced separately. */
export async function rememberOrderCustomer(
  db: D1Database,
  orderId: string,
  attemptId: string,
  customerId: string,
  complete = true
): Promise<void> {
  const now = new Date().toISOString();
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `INSERT INTO order_stripe_customers(order_id,customer_id,attempt_id,created_at) VALUES(?,?,?,?)
       ON CONFLICT(order_id,customer_id) DO NOTHING`
      )
      .bind(orderId, customerId, attemptId, now),
    db
      .prepare(
        'UPDATE stripe_customer_operations SET observed_at=CASE WHEN ? THEN COALESCE(observed_at,?) ELSE observed_at END WHERE attempt_id=?'
      )
      .bind(complete ? 1 : 0, now, attemptId),
    customerDeletionStatement(db, {
      sql: 'c.order_id=? AND c.customer_id=?',
      values: [orderId, customerId],
    }),
  ]);
  for (const { id } of results[2]?.results ?? [])
    await enqueueJob({ type: 'stripe.customer.delete', outboxId: id });
}

/** One provider page per invocation keeps recovery independent of account size. */
export async function reconcileCustomerOperations(
  db: D1Database,
  provider: Pick<PaymentProvider, 'listCustomersPage'>,
  cutoff = new Date().toISOString()
): Promise<{ checked: number; more: boolean }> {
  const row = await db
    .prepare(
      `SELECT attempt_id,order_id,created_at,creation_deadline_at,reconcile_cursor FROM stripe_customer_operations
     WHERE observed_at IS NULL AND next_reconcile_at<=? ORDER BY next_reconcile_at,attempt_id LIMIT 1`
    )
    .bind(cutoff)
    .first<{
      attempt_id: string;
      order_id: string;
      created_at: string;
      creation_deadline_at: string;
      reconcile_cursor: string | null;
    }>();
  if (!row) return { checked: 0, more: false };
  if (!provider.listCustomersPage) throw new Error('Customer reconciliation unavailable');
  const page = await provider.listCustomersPage(
    {
      limit: 100,
      createdAfter: Math.floor(Date.parse(row.created_at) / 1000) - 60,
      createdBefore: Math.ceil(Date.parse(row.creation_deadline_at) / 1000) + 60,
      startingAfter: row.reconcile_cursor ?? undefined,
    },
    { timeoutMs: 10_000 }
  );
  for (const customer of page.data) {
    if (
      customer.metadata.order_id === row.order_id &&
      customer.metadata.attempt_id === row.attempt_id
    )
      await rememberOrderCustomer(db, row.order_id, row.attempt_id, customer.id, false);
  }
  const cursor = page.hasMore ? page.data.at(-1)?.id : null;
  if (page.hasMore && (!cursor || cursor === row.reconcile_cursor))
    throw new Error('Customer reconciliation cursor did not advance');
  await db
    .prepare(
      `UPDATE stripe_customer_operations SET reconcile_cursor=?,next_reconcile_at=?,observed_at=CASE
       WHEN ? AND EXISTS(SELECT 1 FROM order_stripe_customers WHERE attempt_id=?) THEN ? ELSE observed_at END
     WHERE attempt_id=? AND reconcile_cursor IS ? AND observed_at IS NULL`
    )
    .bind(
      cursor ?? null,
      page.hasMore ? cutoff : new Date(Date.parse(cutoff) + 6 * 60 * 60_000).toISOString(),
      page.hasMore ? 0 : 1,
      row.attempt_id,
      cutoff,
      row.attempt_id,
      row.reconcile_cursor
    )
    .run();
  const more = Boolean(
    await db
      .prepare(
        'SELECT 1 FROM stripe_customer_operations WHERE observed_at IS NULL AND next_reconcile_at<=? LIMIT 1'
      )
      .bind(cutoff)
      .first()
  );
  return { checked: 1, more };
}

export async function privacyRecoveryReport(db: D1Database) {
  const [history, pending, scrubbed] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM orders o INDEXED BY orders_privacy_gap_idx WHERE o.checkout_attempt_id IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM checkout_intents ci WHERE ci.order_id=o.id)
       AND NOT EXISTS(SELECT 1 FROM order_stripe_customers c WHERE c.order_id=o.id)`
      )
      .first<{ count: number }>(),
    db
      .prepare('SELECT COUNT(*) AS count FROM stripe_customer_operations WHERE observed_at IS NULL')
      .first<{ count: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM outbox WHERE type='email.send' AND status='failed' AND payload_json='{}'"
      )
      .first<{ count: number }>(),
  ]);
  return {
    historicalOrdersWithoutCustomerAssociation: history?.count ?? 0,
    unresolvedCustomerOperations: pending?.count ?? 0,
    ambiguousScrubbedEmails: scrubbed?.count ?? 0,
    historicalProviderReconciliationRequired: true,
  };
}

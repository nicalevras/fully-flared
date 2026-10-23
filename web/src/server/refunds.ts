import { releaseOrderHoldsStmts, restockOrderStatements } from './inventory';
import { resolvePaymentOrder } from './payment-order';
import type { PaymentProvider } from './payments';
import { nextRetryIso } from './retry';
import { emailStatement, operationalRecipients, commitWithEmails } from './email';
import { getSettings } from './settings';
import { reconciliationCursors, advanceCursor, type CursorClaim } from './reconcile-cursors';

// Stripe may prune idempotency keys after 24h; never blindly recreate after 23h.
const REFUND_CREATION_RETRY_CUTOFF_MS = 23 * 60 * 60_000;

type RefundState =
  'pending' | 'requires_action' | 'uncertain' | 'succeeded' | 'failed' | 'canceled';
type Purpose = 'staff' | 'return' | 'late_payment' | 'external';
const at = () => new Date().toISOString();
const states = new Set<RefundState>([
  'pending',
  'requires_action',
  'uncertain',
  'succeeded',
  'failed',
  'canceled',
]);

export async function settleRefund(
  db: D1Database,
  refundId: string,
  status: string,
  stripeId?: string
) {
  if (!states.has(status as RefundState)) throw new Error('Unknown provider refund state');
  const row = await db
    .prepare(
      `SELECT r.*, o.number, o.customer_email FROM refunds r JOIN orders o ON o.id=r.order_id WHERE r.id=?`
    )
    .bind(refundId)
    .first<{
      id: string;
      order_id: string;
      purpose: Purpose;
      recovery_reason: 'capacity_unavailable' | 'currency_changed' | null;
      return_id: string | null;
      restock: number;
      number: string;
      customer_email: string;
    }>();
  if (!row) return;
  const timestamp = at();
  const recipients = ['failed', 'canceled', 'requires_action', 'uncertain'].includes(status)
    ? await operationalRecipients(db)
    : [];
  const total =
    "COALESCE((SELECT SUM(amount_cents) FROM refunds WHERE order_id=orders.id AND status='succeeded'),0)";
  const statements = [
    db
      .prepare(
        `UPDATE refunds SET status=?,stripe_refund_id=COALESCE(?,stripe_refund_id),settled_at=CASE WHEN ?='succeeded' THEN COALESCE(settled_at,?) ELSE settled_at END WHERE id=? AND (status NOT IN ('failed','canceled') OR status=?) AND (status!='succeeded' OR ? IN ('succeeded','failed','canceled'))`
      )
      .bind(status, stripeId ?? null, status, timestamp, refundId, status, status),
    db
      .prepare(
        `UPDATE orders SET payment_status=CASE WHEN payment_status='disputed' THEN 'disputed' WHEN ${total}>=total_cents THEN 'refunded' WHEN ${total}>0 THEN 'partially_refunded' ELSE CASE WHEN payment_status IN ('refunded','partially_refunded') THEN 'paid' ELSE payment_status END END,
      status=CASE WHEN ${total}>=total_cents THEN CASE WHEN status IN ('shipped','delivered','pending_payment','canceled') THEN status ELSE 'refunded' END WHEN ${total}>0 THEN CASE WHEN status IN ('shipped','delivered','pending_payment','canceled') THEN status ELSE 'partially_refunded' END ELSE CASE WHEN status IN ('refunded','partially_refunded') THEN 'paid' ELSE status END END,updated_at=? WHERE id=?`
      )
      .bind(timestamp, row.order_id),
    ...releaseOrderHoldsStmts(db, row.order_id, {
      sql: `EXISTS(SELECT 1 FROM orders WHERE id=? AND ${total}>=total_cents)`,
      values: [row.order_id],
    }),
    db
      .prepare(
        `UPDATE discounts SET usage_count=usage_count-1 WHERE id IN(SELECT discount_id FROM discount_usage WHERE order_id=?) AND usage_count>0 AND EXISTS(SELECT 1 FROM orders WHERE id=? AND ${total}>=total_cents AND NOT EXISTS(SELECT 1 FROM reservations WHERE order_id=? AND status='committed'))`
      )
      .bind(row.order_id, row.order_id, row.order_id),
    db
      .prepare(
        `DELETE FROM discount_usage WHERE order_id=? AND EXISTS(SELECT 1 FROM orders WHERE id=? AND ${total}>=total_cents AND NOT EXISTS(SELECT 1 FROM reservations WHERE order_id=? AND status='committed'))`
      )
      .bind(row.order_id, row.order_id, row.order_id),
    ...restockOrderStatements(db, row.order_id, {
      sql: `EXISTS(SELECT 1 FROM orders WHERE id=? AND ${total}>=total_cents) AND EXISTS(SELECT 1 FROM refunds WHERE order_id=? AND restock=1 AND status='succeeded')`,
      values: [row.order_id, row.order_id],
    }),
    db
      .prepare(
        `UPDATE returns SET status='refunded' WHERE id=? AND status IN ('requested','approved','refund_failed') AND EXISTS(SELECT 1 FROM refunds WHERE id=? AND status='succeeded')`
      )
      .bind(row.return_id, refundId),
    // A refund that genuinely fails after succeeding un-closes the return.
    // 'refund_failed' is not in the open-return unique index, so this can
    // never collide with a second open return on the same order.
    db
      .prepare(
        `UPDATE returns SET status='refund_failed' WHERE id=? AND status='refunded' AND ? IN ('failed','canceled') AND EXISTS(SELECT 1 FROM refunds WHERE id=? AND status IN ('failed','canceled'))`
      )
      .bind(row.return_id, status, refundId),
  ];
  if (status === 'succeeded') {
    const text =
      row.purpose === 'late_payment'
        ? row.recovery_reason === 'currency_changed'
          ? `Your payment for expired checkout ${row.number} arrived after the store changed currency, so it has been refunded in full in the original payment currency.`
          : `Checkout ${row.number} could not be completed or was canceled. Its payment has been refunded in full.`
        : `Your refund for order ${row.number} has succeeded.`;
    statements.push(
      emailStatement(
        db,
        `refund-${refundId}`,
        {
          to: row.customer_email,
          subject: `Order ${row.number} refund`,
          text,
          html: `<p>${text}</p>`,
        },
        {
          sql: "EXISTS(SELECT 1 FROM refunds WHERE id=? AND status='succeeded')",
          values: [refundId],
        }
      )
    );
  }
  for (const to of recipients)
    statements.push(
      emailStatement(db, `refund-alert-${refundId}-${status}-${to}`, {
        to,
        subject: `Refund ${status}: ${row.number}`,
        text: `Refund operation ${refundId} is ${status}. Check Stripe before retrying.`,
        html: `<p>Refund operation ${refundId} is ${status}. Check Stripe before retrying.</p>`,
      })
    );
  await commitWithEmails(db, statements, [
    ...(status === 'succeeded' ? [`refund-${refundId}`] : []),
    ...recipients.map((to) => `refund-alert-${refundId}-${status}-${to}`),
  ]);
}

export async function requestRefund(
  db: D1Database,
  provider: PaymentProvider | undefined,
  input: {
    orderId: string;
    amountCents?: number | undefined;
    requestId: string;
    purpose: Purpose;
    returnId?: string;
    restock?: boolean;
    recoveryReason?: 'capacity_unavailable' | 'currency_changed';
  }
) {
  const order = await db
    .prepare('SELECT total_cents,stripe_payment_intent_id FROM orders WHERE id=?')
    .bind(input.orderId)
    .first<{ total_cents: number; stripe_payment_intent_id: string | null }>();
  if (!order) throw new Error('Order not found');
  const prior = await db
    .prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS s FROM refunds WHERE order_id=? AND status NOT IN ('failed','canceled')"
    )
    .bind(input.orderId)
    .first<{ s: number }>();
  const amount = input.amountCents ?? order.total_cents - (prior?.s ?? 0);
  let row = await db
    .prepare('SELECT * FROM refunds WHERE request_id=?')
    .bind(input.requestId)
    .first<{
      id: string;
      order_id: string;
      purpose: Purpose;
      amount_cents: number;
      status: string;
      stripe_refund_id: string | null;
      created_at: string;
      attempts: number;
      retry_after: string | null;
    }>();
  if (!row) {
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Invalid refundable balance');
    const gate = {
      sql: "EXISTS(SELECT 1 FROM refunds WHERE request_id=? AND purpose='late_payment')",
      values: [input.requestId],
    };
    await db.batch([
      db
        .prepare(
          `INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,return_id,restock,recovery_reason,status,created_at) SELECT ?,?,?,?,?,?,?,?,'uncertain',? WHERE NOT EXISTS(SELECT 1 FROM refunds WHERE request_id=?) ${input.purpose === 'late_payment' ? "AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status IN ('pending_payment','canceled') AND payment_status IN ('unpaid','failed'))" : ''} ON CONFLICT(request_id) DO NOTHING`
        )
        .bind(
          input.requestId,
          input.requestId,
          input.orderId,
          amount,
          input.purpose,
          input.returnId ?? null,
          input.restock ? 1 : 0,
          input.purpose === 'late_payment'
            ? (input.recoveryReason ?? 'capacity_unavailable')
            : null,
          at(),
          input.requestId,
          ...(input.purpose === 'late_payment' ? [input.orderId] : [])
        ),
      ...(input.purpose === 'late_payment'
        ? [
            db
              .prepare(
                `UPDATE orders SET status='canceled',payment_status='paid',updated_at=? WHERE id=? AND ${gate.sql}`
              )
              .bind(at(), input.orderId, ...gate.values),
            ...releaseOrderHoldsStmts(db, input.orderId, gate),
            db
              .prepare(
                `UPDATE discounts SET usage_count=usage_count-1 WHERE id IN(SELECT discount_id FROM discount_usage WHERE order_id=?) AND usage_count>0 AND ${gate.sql}`
              )
              .bind(input.orderId, ...gate.values),
            db
              .prepare(`DELETE FROM discount_usage WHERE order_id=? AND ${gate.sql}`)
              .bind(input.orderId, ...gate.values),
          ]
        : []),
    ]);
    row = await db
      .prepare('SELECT * FROM refunds WHERE request_id=?')
      .bind(input.requestId)
      .first<typeof row & {}>();
  }
  if (!row) {
    if (input.purpose === 'late_payment')
      return { ok: false as const, error: 'Order already completed', status: 409 };
    throw new Error('Refund operation missing');
  }
  if (
    row.order_id !== input.orderId ||
    row.purpose !== input.purpose ||
    (input.amountCents != null && input.amountCents !== row.amount_cents)
  )
    throw new Error('Refund request identity does not match operation');
  const response = () => ({
    ok: true as const,
    stripeRefundId: row!.stripe_refund_id,
    amount: row!.amount_cents,
    status: row!.status,
  });
  if (['succeeded', 'failed', 'canceled'].includes(row.status)) return response();
  const { limits } = await getSettings(db);
  const claim = await db
    .prepare(
      'UPDATE refunds SET attempts=attempts+1,retry_after=? WHERE id=? AND attempts<? AND (retry_after IS NULL OR retry_after<=?)'
    )
    .bind(nextRetryIso(row.attempts + 1), row.id, limits.refund_retry_cap, at())
    .run();
  if (!claim.meta.changes) return response();
  if (!provider || !order.stripe_payment_intent_id) {
    await settleRefund(db, row.id, 'uncertain');
    return response();
  }
  try {
    // Retrieve known refunds; reconcile ambiguous creation before reusing its stable key.
    const known =
      row.stripe_refund_id && provider.retrieveRefund
        ? await provider.retrieveRefund(row.stripe_refund_id)
        : provider.findRefundByOperation
          ? await provider.findRefundByOperation(order.stripe_payment_intent_id, row.id)
          : null;
    if (row.stripe_refund_id && !known) return response();
    if (!known && Date.now() - Date.parse(row.created_at) > REFUND_CREATION_RETRY_CUTOFF_MS)
      throw new Error('Refund requires provider reconciliation before retry');
    const result =
      known ?? (await provider.refund(order.stripe_payment_intent_id, row.amount_cents, row.id));
    await settleRefund(db, row.id, result.status, result.id);
    return {
      ok: true as const,
      stripeRefundId: result.id,
      amount: row.amount_cents,
      status: result.status,
    };
  } catch (error) {
    await settleRefund(db, row.id, 'uncertain');
    throw error;
  }
}

export async function handleRefundEvent(
  db: D1Database,
  type: string,
  data: Record<string, unknown>,
  provider?: PaymentProvider
) {
  if (typeof data.id !== 'string') throw new Error('Refund event missing identity');
  const metadata = data.metadata as { operation_id?: string } | undefined;
  let row = await db
    .prepare('SELECT id FROM refunds WHERE stripe_refund_id=? OR request_id=?')
    .bind(data.id, metadata?.operation_id ?? '')
    .first<{ id: string }>();
  if (!row && typeof data.payment_intent === 'string') {
    const order = await resolvePaymentOrder(db, data.payment_intent, provider);
    if (!order) throw new Error('Refund order has not arrived yet');
    // Older operations used deterministic late IDs without provider metadata.
    row = await db
      .prepare('SELECT id FROM refunds WHERE id=? AND stripe_refund_id IS NULL')
      .bind(`late-${order.id}`)
      .first<{ id: string }>();
    if (!row) {
      if (typeof data.amount !== 'number') throw new Error('Refund amount missing');
      await db
        .prepare(
          `INSERT OR IGNORE INTO refunds(id,request_id,order_id,stripe_refund_id,amount_cents,purpose,status,created_at) VALUES(?,?,?,?,?,'external','pending',?)`
        )
        .bind(data.id, data.id, order.id, data.id, data.amount, at())
        .run();
      row = { id: data.id };
    }
  }
  if (!row) throw new Error('Refund operation has not arrived yet');
  const current = provider?.retrieveRefund ? await provider.retrieveRefund(data.id) : null;
  await settleRefund(
    db,
    row.id,
    current?.status ?? (type === 'refund.failed' ? 'failed' : String(data.status)),
    data.id
  );
}

export async function syncChargeRefund(
  db: D1Database,
  data: Record<string, unknown>,
  provider?: PaymentProvider
) {
  const refunds = data.refunds as { data?: Record<string, unknown>[] } | undefined;
  if (refunds?.data?.length) {
    for (const refund of refunds.data)
      await handleRefundEvent(db, 'refund.updated', refund, provider);
    return;
  }
  if (provider?.listRefunds && typeof data.payment_intent === 'string') {
    for (const refund of await provider.listRefunds(data.payment_intent))
      await handleRefundEvent(db, 'refund.updated', refund, provider);
    return;
  }
  // A cumulative charge amount cannot identify which pending refund settled.
  // Retry after retrieving the individual refunds instead of inventing successful operations.
  const order = await resolvePaymentOrder(db, String(data.payment_intent), provider);
  if (!order) throw new Error('Refund order has not arrived yet');
  const pending = await db
    .prepare(
      "SELECT id,amount_cents FROM refunds WHERE order_id=? AND status IN ('pending','uncertain','requires_action')"
    )
    .bind(order.id)
    .all<{ id: string; amount_cents: number }>();
  const succeeded = await db
    .prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS s FROM refunds WHERE order_id=? AND status='succeeded'"
    )
    .bind(order.id)
    .first<{ s: number }>();
  const delta = Number(data.amount_refunded) - (succeeded?.s ?? 0);
  if (pending.results.length === 1 && pending.results[0]!.amount_cents === delta)
    await settleRefund(db, pending.results[0]!.id, 'succeeded');
  else if (delta > 0) throw new Error('Individual provider refunds required for reconciliation');
}

export async function reconcileRefundOperations(
  db: D1Database,
  provider?: PaymentProvider,
  limit = 25,
  claim?: CursorClaim,
  dueBefore = at()
): Promise<number> {
  const { limits } = await getSettings(db);
  const cursors = await reconciliationCursors(db, ['refund_operations', 'refund_stuck']);
  const rows = await db
    .prepare(
      "SELECT id,order_id,amount_cents,purpose FROM refunds WHERE id>? AND status IN ('uncertain','pending','requires_action') AND attempts<? AND (retry_after IS NULL OR retry_after<=?) ORDER BY id LIMIT ?"
    )
    .bind(cursors.get('refund_operations') ?? '', limits.refund_retry_cap, dueBefore, limit)
    .all<{ id: string; order_id: string; amount_cents: number; purpose: Purpose }>();
  let succeeded = true;
  for (const row of rows.results) {
    try {
      await requestRefund(db, provider, {
        orderId: row.order_id,
        amountCents: row.amount_cents,
        requestId: row.id,
        purpose: row.purpose,
      });
    } catch (error) {
      succeeded = false;
      console.error(
        JSON.stringify({
          event: 'refund_reconciliation_failed',
          operationId: row.id,
          error: String(error),
        })
      );
    }
  }
  if (succeeded)
    await advanceCursor(
      db,
      'refund_operations',
      cursors.get('refund_operations') ?? '',
      rows.results.length === limit ? rows.results.at(-1)!.id : '',
      claim
    );
  const stuck = await db
    .prepare(
      "SELECT id,status FROM refunds WHERE id>? AND status IN ('uncertain','pending','requires_action') AND (attempts>=? OR created_at<?) ORDER BY id LIMIT 25"
    )
    .bind(
      cursors.get('refund_stuck') ?? '',
      limits.refund_retry_cap,
      new Date(Date.now() - limits.refund_stuck_minutes * 60_000).toISOString()
    )
    .all<{ id: string; status: string }>();
  const recipients = await operationalRecipients(db);
  for (const row of stuck.results)
    if (recipients.length)
      await commitWithEmails(
        db,
        recipients.map((to) =>
          emailStatement(db, `refund-stuck-${row.id}-${to}`, {
            to,
            subject: 'Refund operation needs attention',
            text: `Refund operation ${row.id} is ${row.status}. Check Stripe before retrying.`,
            html: `<p>Refund operation ${row.id} needs attention. Check Stripe before retrying.</p>`,
          })
        ),
        recipients.map((to) => `refund-stuck-${row.id}-${to}`)
      );
  await advanceCursor(
    db,
    'refund_stuck',
    cursors.get('refund_stuck') ?? '',
    stuck.results.length === 25 ? stuck.results.at(-1)!.id : '',
    claim
  );
  return rows.results.length;
}

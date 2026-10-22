import { rememberProviderSession } from './checkout-intents';
import type { PaymentProvider } from './payments';
import { reconciliationCursors, advanceCursor } from './reconcile-cursors';

export type ReconcileReport = {
  checkedStripeSessions: number;
  checkedOrders: number;
  checkedRefunds: number;
  mismatches: string[];
};

export async function reconcileStripe(
  db: D1Database,
  provider: PaymentProvider,
  opts: { maxPages?: number; orderLimit?: number } = {}
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    checkedStripeSessions: 0,
    checkedOrders: 0,
    checkedRefunds: 0,
    mismatches: [],
  };
  const cursors = await reconciliationCursors(db);
  const localLimit = Math.min(25, Math.max(1, opts.orderLimit ?? 25));
  const advance = async (name: string, next: string) =>
    advanceCursor(db, name, cursors.get(name) ?? '', next);
  if (provider.listCheckoutSessionsPage && opts.maxPages !== 0) {
    const previous = cursors.get('stripe_sessions') ?? '';
    const page = await provider.listCheckoutSessionsPage({
      limit: 100,
      startingAfter: previous || undefined,
    });
    if (page.data.length > 100) throw new Error('Provider page exceeds reconciliation bound');
    report.checkedStripeSessions = page.data.length;
    const orders = new Map<
      string,
      { id: string; payment_status: string; total_cents: number; currency: string }
    >();
    // Stay below D1's 100-parameter statement bound, including a full provider page.
    for (let offset = 0; offset < page.data.length; offset += 90) {
      const ids = page.data.slice(offset, offset + 90).map((s) => s.id);
      const rows = await db
        .prepare(
          `SELECT id,stripe_checkout_session_id,payment_status,total_cents,currency FROM orders WHERE stripe_checkout_session_id IN (${ids.map(() => '?').join(',')})`
        )
        .bind(...ids)
        .all<{
          id: string;
          stripe_checkout_session_id: string;
          payment_status: string;
          total_cents: number;
          currency: string;
        }>();
      for (const row of rows.results) orders.set(row.stripe_checkout_session_id, row);
    }
    for (const session of page.data) {
      await rememberProviderSession(db, session);
      const free = session.payment_status === 'no_payment_required' && session.amount_total === 0;
      if (session.payment_status !== 'paid' && !free) continue;
      const order = orders.get(session.id);
      if (!order) report.mismatches.push(`stripe_paid_no_order:${session.id}`);
      else if (
        !['paid', 'partially_refunded', 'refunded', 'disputed'].includes(order.payment_status)
      )
        report.mismatches.push(`stripe_paid_order_not_paid:${session.id}:${order.id}`);
      else if (session.currency.toUpperCase() !== order.currency.toUpperCase())
        report.mismatches.push(`stripe_currency_mismatch:${session.id}:${order.id}`);
      else if (session.amount_total != null && session.amount_total < order.total_cents)
        report.mismatches.push(`stripe_paid_amount_low:${session.id}:${order.id}`);
    }
    await advance('stripe_sessions', page.hasMore && page.data.length ? page.data.at(-1)!.id : '');
  }
  if (provider.retrieveCheckoutSession) {
    const rows = await db
      .prepare(
        `SELECT id,stripe_checkout_session_id,total_cents FROM orders WHERE id>? AND payment_status IN ('paid','partially_refunded','refunded','disputed') AND stripe_checkout_session_id IS NOT NULL ORDER BY id LIMIT ?`
      )
      .bind(cursors.get('orders') ?? '', localLimit)
      .all<{ id: string; stripe_checkout_session_id: string; total_cents: number }>();
    for (const order of rows.results) {
      const session = await provider.retrieveCheckoutSession(order.stripe_checkout_session_id);
      report.checkedOrders++;
      if (!session)
        report.mismatches.push(
          `order_paid_session_missing:${order.id}:${order.stripe_checkout_session_id}`
        );
      else if (
        session.payment_status !== 'paid' &&
        !(
          session.payment_status === 'no_payment_required' &&
          session.amount_total === 0 &&
          order.total_cents === 0
        )
      )
        report.mismatches.push(
          `order_paid_session_unpaid:${order.id}:${order.stripe_checkout_session_id}`
        );
    }
    await advance('orders', rows.results.length === localLimit ? rows.results.at(-1)!.id : '');
  }
  if (provider.retrieveRefund) {
    const rows = await db
      .prepare(
        'SELECT id,stripe_refund_id,status FROM refunds WHERE id>? AND stripe_refund_id IS NOT NULL ORDER BY id LIMIT 25'
      )
      .bind(cursors.get('refunds') ?? '')
      .all<{ id: string; stripe_refund_id: string; status: string }>();
    for (const row of rows.results) {
      const current = await provider.retrieveRefund(row.stripe_refund_id);
      report.checkedRefunds++;
      if (!current) report.mismatches.push(`refund_provider_missing:${row.id}`);
      else if (current.status !== row.status)
        report.mismatches.push(`refund_provider_mismatch:${row.id}:${current.status}`);
    }
    await advance('refunds', rows.results.length === 25 ? rows.results.at(-1)!.id : '');
  }
  // Page the source records, not only mismatches, so healthy prefixes cannot starve older rows.
  const stock = await db
    .prepare(
      `SELECT s.sku,s.on_hand,s.reserved,COALESCE((SELECT SUM(delta_on_hand) FROM stock_ledger WHERE sku=s.sku),0) AS h,COALESCE((SELECT SUM(delta_reserved) FROM stock_ledger WHERE sku=s.sku),0) AS r FROM (SELECT * FROM stock WHERE sku>? ORDER BY sku LIMIT 50) s`
    )
    .bind(cursors.get('stock') ?? '')
    .all<{ sku: string; on_hand: number; reserved: number; h: number; r: number }>();
  for (const row of stock.results)
    if (row.on_hand !== row.h || row.reserved !== row.r)
      report.mismatches.push(`stock_ledger_drift:${row.sku}`);
  await advance('stock', stock.results.length === 50 ? stock.results.at(-1)!.sku : '');
  const totals = await db
    .prepare(
      `SELECT o.id,o.payment_status,o.total_cents,COALESCE((SELECT SUM(amount_cents) FROM refunds WHERE order_id=o.id AND status='succeeded'),0) AS succeeded,COALESCE((SELECT SUM(amount_cents) FROM refunds WHERE order_id=o.id AND status NOT IN ('failed','canceled')),0) AS reserved FROM (SELECT id,payment_status,total_cents FROM orders WHERE id>? ORDER BY id LIMIT 50) o`
    )
    .bind(cursors.get('refund_totals') ?? '')
    .all<{
      id: string;
      payment_status: string;
      total_cents: number;
      succeeded: number;
      reserved: number;
    }>();
  for (const row of totals.results)
    if (
      row.reserved > row.total_cents ||
      (row.payment_status === 'refunded' && row.succeeded !== row.total_cents) ||
      (row.payment_status === 'partially_refunded' &&
        (row.succeeded <= 0 || row.succeeded >= row.total_cents)) ||
      (['paid', 'unpaid'].includes(row.payment_status) && row.succeeded > 0)
    )
      report.mismatches.push(`refund_total_mismatch:${row.id}`);
  await advance('refund_totals', totals.results.length === 50 ? totals.results.at(-1)!.id : '');
  return report;
}

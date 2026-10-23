/** Compose cancellation inside the caller's transaction. The transition
 * identifies precisely the orders whose holds and coupon claims may move. */
export function cancelOrdersStatements(
  db: D1Database,
  scope: { sql: string; values: (string | number | null)[] },
  transition = crypto.randomUUID(),
  includeCanceledFree = false
): D1PreparedStatement[] {
  const at = new Date().toISOString();
  const orders = 'SELECT id FROM orders WHERE transition_id=?';
  return [
    db
      .prepare(
        `UPDATE checkout_intents SET cancel_requested=1,payment_next_at=?,creation_stopped_at=COALESCE(creation_stopped_at,?),updated_at=?
      WHERE flow='manual_capture' AND payment_state NOT IN ('finalized','canceled') AND order_id IN(SELECT id FROM orders WHERE (${scope.sql}))`
      )
      .bind(at, at, at, ...scope.values),
    db
      .prepare(
        `UPDATE orders SET status='canceled',transition_id=?,updated_at=?
      WHERE (${scope.sql}) AND NOT EXISTS(SELECT 1 FROM checkout_intents ci WHERE ci.order_id=orders.id AND ci.flow='manual_capture' AND ci.allocation_id IS NOT NULL AND ci.payment_state NOT IN ('canceled','finalized')) AND payment_status IN ('unpaid','failed') AND ${
        includeCanceledFree
          ? "status IN ('pending_payment','canceled') AND total_cents=0 AND NOT EXISTS(SELECT 1 FROM outbox WHERE id='expired-free-'||orders.id)"
          : "status='pending_payment'"
      }`
      )
      .bind(transition, at, ...scope.values),
    db
      .prepare(
        `UPDATE checkout_intents SET creation_stopped_at=COALESCE(creation_stopped_at,?),
      state=CASE WHEN first_provider_attempt_at IS NOT NULL OR stripe_session_id IS NOT NULL OR state IN ('session_creating','reconciliation_required') THEN 'reconciliation_required' ELSE 'canceled' END,
      claim_token=NULL,claim_expires_at=NULL,fencing=fencing+1,updated_at=?
      WHERE order_id IN (${orders}) AND state NOT IN ('canceled','expired')`
      )
      .bind(at, at, transition),
    db
      .prepare(
        `INSERT INTO stock_ledger(id,sku,delta_reserved,reason,ref_type,ref_id,created_at)
      SELECT 'release-'||id,sku,-qty,'release','reservation',id,? FROM reservations
      WHERE order_id IN (${orders}) AND status='active'`
      )
      .bind(at, transition),
    db
      .prepare(
        `UPDATE stock SET reserved=reserved-COALESCE((SELECT SUM(qty) FROM reservations
      WHERE order_id IN (${orders}) AND sku=stock.sku AND status='active'),0),updated_at=?
      WHERE sku IN(SELECT sku FROM reservations WHERE order_id IN (${orders}) AND status='active')`
      )
      .bind(transition, at, transition),
    db
      .prepare(
        `UPDATE reservations SET status='released' WHERE order_id IN (${orders}) AND status='active'`
      )
      .bind(transition),
    db
      .prepare(
        `UPDATE discounts SET usage_count=usage_count-(SELECT COUNT(*) FROM discount_usage
      WHERE discount_id=discounts.id AND order_id IN (${orders}))
      WHERE id IN(SELECT discount_id FROM discount_usage WHERE order_id IN (${orders}))`
      )
      .bind(transition, transition),
    db.prepare(`DELETE FROM discount_usage WHERE order_id IN (${orders})`).bind(transition),
  ];
}

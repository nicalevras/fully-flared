export type CurrencyRevenue = { currency: string; revenue: number; orders: number };

// Gross sales retain refunded payments, but never count unfulfilled recovery payments.
export const grossSalePredicate = (alias: string) =>
  `${alias}.payment_status IN ('paid','partially_refunded','refunded') AND NOT EXISTS (SELECT 1 FROM refunds recovery WHERE recovery.order_id=${alias}.id AND recovery.purpose='late_payment' AND NOT EXISTS (SELECT 1 FROM reservations sale WHERE sale.order_id=${alias}.id AND sale.status='committed'))`;

/** Amounts are only additive within the order's original currency. */
export async function paidRevenueByCurrency(db: D1Database): Promise<CurrencyRevenue[]> {
  return (
    await db
      .prepare(
        `SELECT currency,SUM(total_cents) AS revenue,COUNT(*) AS orders FROM orders o WHERE ${grossSalePredicate('o')} GROUP BY currency ORDER BY currency`
      )
      .all<CurrencyRevenue>()
  ).results;
}

export const monetaryReportQueries = {
  sales: `SELECT date(created_at) AS day,COUNT(*) AS orders,SUM(total_cents) AS total_cents,currency FROM orders o WHERE ${grossSalePredicate('o')} GROUP BY day,currency ORDER BY day DESC LIMIT 90`,
  products: `SELECT i.sku,i.title,o.currency,SUM(i.qty) AS units,SUM(i.qty*i.unit_price_cents) AS revenue_cents FROM order_items i JOIN orders o ON o.id=i.order_id WHERE ${grossSalePredicate('o')} GROUP BY i.sku,i.title,o.currency ORDER BY revenue_cents DESC LIMIT 100`,
  customers: `SELECT customer_email,currency,COUNT(*) AS orders,SUM(total_cents) AS spent_cents FROM orders o WHERE ${grossSalePredicate('o')} GROUP BY customer_email,currency ORDER BY spent_cents DESC LIMIT 100`,
} as const;

export type DashboardPeriodStats = {
  currency: string;
  grossCents: number;
  refundCents: number;
  netCents: number;
  paidOrders: number;
  aovCents: number;
};

/**
 * Period stats in UTC. Gross sales use the order date. Refunds use the
 * refund creation date and only count settled refunds, so a refund appears
 * in the period it was issued even when the order is older. Currencies are
 * never summed together.
 */
export async function dashboardStats(
  db: D1Database,
  fromIso: string,
  toIso: string
): Promise<DashboardPeriodStats[]> {
  const gross = (
    await db
      .prepare(
        `SELECT currency,SUM(total_cents) AS gross,COUNT(*) AS orders FROM orders o WHERE ${grossSalePredicate('o')} AND o.created_at >= ? AND o.created_at < ? GROUP BY currency`
      )
      .bind(fromIso, toIso)
      .all<{ currency: string; gross: number; orders: number }>()
  ).results;
  const refunds = (
    await db
      .prepare(
        `SELECT o.currency AS currency,SUM(r.amount_cents) AS refunds FROM refunds r JOIN orders o ON o.id = r.order_id WHERE r.status = 'succeeded' AND r.created_at >= ? AND r.created_at < ? GROUP BY o.currency`
      )
      .bind(fromIso, toIso)
      .all<{ currency: string; refunds: number }>()
  ).results;
  const refundByCurrency = new Map(refunds.map((r) => [r.currency, r.refunds]));
  const currencies = new Set([...gross.map((g) => g.currency), ...refunds.map((r) => r.currency)]);
  return [...currencies].sort().map((currency) => {
    const g = gross.find((row) => row.currency === currency);
    const grossCents = g?.gross ?? 0;
    const paidOrders = g?.orders ?? 0;
    const refundCents = refundByCurrency.get(currency) ?? 0;
    return {
      currency,
      grossCents,
      refundCents,
      netCents: grossCents - refundCents,
      paidOrders,
      aovCents: paidOrders ? Math.round(grossCents / paidOrders) : 0,
    };
  });
}

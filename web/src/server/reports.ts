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

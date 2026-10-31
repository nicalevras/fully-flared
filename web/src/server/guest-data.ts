import { normalizeContactEmail } from './admin-contacts';

export type GuestDataPreview = {
  email: string;
  orderCount: number;
  orders: Array<{
    id: string;
    number: string;
    total_cents: number;
    currency: string;
    created_at: string;
  }>;
  returnCount: number;
  refundCount: number;
  totals: Array<{ currency: string; orders: number; total_cents: number }>;
};

export async function previewGuestData(
  db: D1Database,
  rawEmail: string
): Promise<GuestDataPreview | null> {
  const email = normalizeContactEmail(rawEmail);
  if (!email) return null;
  const [count, orders, returns, refunds, totals] = await Promise.all([
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM orders WHERE user_id IS NULL AND lower(customer_email) = ?'
      )
      .bind(email)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT id, number, total_cents, currency, created_at FROM orders WHERE user_id IS NULL AND lower(customer_email) = ? ORDER BY created_at DESC, id DESC LIMIT 50`
      )
      .bind(email)
      .all<GuestDataPreview['orders'][number]>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM returns r JOIN orders o ON o.id = r.order_id WHERE o.user_id IS NULL AND lower(o.customer_email) = ?`
      )
      .bind(email)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM refunds f JOIN orders o ON o.id = f.order_id WHERE o.user_id IS NULL AND lower(o.customer_email) = ?`
      )
      .bind(email)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT currency, COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS total_cents FROM orders WHERE user_id IS NULL AND lower(customer_email) = ? GROUP BY currency ORDER BY currency`
      )
      .bind(email)
      .all<GuestDataPreview['totals'][number]>(),
  ]);
  return {
    email,
    orderCount: count?.n ?? 0,
    orders: orders.results,
    returnCount: returns?.n ?? 0,
    refundCount: refunds?.n ?? 0,
    totals: totals.results,
  };
}

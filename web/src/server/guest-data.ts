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

export async function exportGuestData(db: D1Database, rawEmail: string) {
  const email = normalizeContactEmail(rawEmail);
  if (!email) return null;
  const preview = await previewGuestData(db, email);
  if (!preview || preview.orderCount === 0) return null;
  const orders = await db
    .prepare(
      `SELECT id, number, status, payment_status AS paymentStatus, currency, subtotal_cents AS subtotalCents, discount_cents AS discountCents, shipping_cents AS shippingCents, tax_cents AS taxCents, total_cents AS totalCents, shipping_name AS shippingName, shipping_address_json AS shippingAddressJson, created_at AS createdAt FROM orders WHERE user_id IS NULL AND lower(customer_email) = ? ORDER BY created_at, id LIMIT 201`
    )
    .bind(email)
    .all<Record<string, unknown> & { id: string }>();
  const exportedOrders = orders.results.slice(0, 200);
  const orderIds = JSON.stringify(exportedOrders.map((order) => order.id));
  const [items, returns] = await Promise.all([
    db
      .prepare(
        `SELECT oi.order_id AS orderId, oi.sku, oi.title, oi.qty, oi.unit_price_cents AS unitPriceCents FROM order_items oi WHERE oi.order_id IN (SELECT value FROM json_each(?)) ORDER BY oi.rowid LIMIT 1001`
      )
      .bind(orderIds)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT r.id, r.order_id AS orderId, r.status, r.reason, r.created_at AS createdAt FROM returns r WHERE r.order_id IN (SELECT value FROM json_each(?)) ORDER BY r.created_at, r.id LIMIT 201`
      )
      .bind(orderIds)
      .all<Record<string, unknown>>(),
  ]);
  return {
    email,
    exportedOrders: exportedOrders.length,
    truncated:
      preview.orderCount > exportedOrders.length ||
      orders.results.length > 200 ||
      items.results.length > 1000 ||
      returns.results.length > 200,
    orders: exportedOrders,
    items: items.results.slice(0, 1000),
    returns: returns.results.slice(0, 200),
    retainedTotals: preview.totals,
  };
}

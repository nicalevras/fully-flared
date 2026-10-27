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

async function emailDigest(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function erasedEmailFor(rawEmail: string): Promise<string> {
  const email = normalizeContactEmail(rawEmail);
  const digest = await emailDigest(email);
  return `erased-${digest.slice(0, 24)}@erased.invalid`;
}

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
  const [orders, items, returns] = await Promise.all([
    db
      .prepare(
        `SELECT id, number, status, payment_status AS paymentStatus, currency, subtotal_cents AS subtotalCents, discount_cents AS discountCents, shipping_cents AS shippingCents, tax_cents AS taxCents, total_cents AS totalCents, shipping_name AS shippingName, shipping_address_json AS shippingAddressJson, created_at AS createdAt FROM orders WHERE user_id IS NULL AND lower(customer_email) = ? ORDER BY created_at, id LIMIT 200`
      )
      .bind(email)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT oi.order_id AS orderId, oi.sku, oi.title, oi.qty, oi.unit_price_cents AS unitPriceCents FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id IS NULL AND lower(o.customer_email) = ? ORDER BY oi.rowid LIMIT 1000`
      )
      .bind(email)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT r.id, r.order_id AS orderId, r.status, r.reason, r.created_at AS createdAt FROM returns r JOIN orders o ON o.id = r.order_id WHERE o.user_id IS NULL AND lower(o.customer_email) = ? ORDER BY r.created_at, r.id LIMIT 200`
      )
      .bind(email)
      .all<Record<string, unknown>>(),
  ]);
  return {
    email,
    exportedOrders: orders.results.length,
    truncated: preview.orderCount > orders.results.length,
    orders: orders.results,
    items: items.results,
    returns: returns.results,
    retainedTotals: preview.totals,
  };
}

export async function eraseGuestData(
  db: D1Database,
  rawEmail: string
): Promise<{ ordersUpdated: number; replacement: string } | null> {
  const email = normalizeContactEmail(rawEmail);
  if (!email) return null;
  const replacement = await erasedEmailFor(email);
  const result = await db
    .prepare(
      `UPDATE orders SET customer_email = ?, shipping_name = NULL, shipping_address_json = NULL, customer_ip = NULL WHERE user_id IS NULL AND lower(customer_email) = ?`
    )
    .bind(replacement, email)
    .run();
  return { ordersUpdated: result.meta.changes ?? 0, replacement };
}

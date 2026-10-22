import { desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import { orders as ordersT, returns as returnsT } from '../db/schema';
import type { OrderStatus, PaymentStatus, ReturnStatus } from '../db/schema';

export const ACCOUNT_ORDERS_PAGE_SIZE = 20;

export type AccountOrderItem = {
  id: string;
  sku: string;
  title: string;
  qty: number;
  returned_qty: number;
};
export type AccountOrderRow = {
  id: string;
  number: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  total_cents: number;
  currency: string;
  created_at: string;
  tracking_number: string | null;
  items: AccountOrderItem[];
};
export type AccountReturnRow = {
  id: string;
  order_id: string;
  status: ReturnStatus;
  created_at: string;
};

/** One page of a customer's order history. Page is validated and clamped
 * here at the server boundary: below 1 becomes 1, beyond the end becomes
 * the last page, an empty history is page 1 of 1. Returns are fetched for
 * the displayed orders only (never a global cap), and returned quantities
 * cover every non-rejected return for those orders' items. */
export async function loadAccountOrders(db: D1Database, userId: string, page: number) {
  const d = getDb(db);
  const totalRow = await db
    .prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id=?')
    .bind(userId)
    .first<{ n: number }>();
  const totalOrders = totalRow?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalOrders / ACCOUNT_ORDERS_PAGE_SIZE));
  const clamped = Math.min(
    Math.max(1, Math.floor(Number.isFinite(page) ? page : 1) || 1),
    pageCount
  );
  const orderRows = await d.query.orders.findMany({
    where: eq(ordersT.userId, userId),
    orderBy: [desc(ordersT.createdAt), desc(ordersT.id)],
    limit: ACCOUNT_ORDERS_PAGE_SIZE,
    offset: (clamped - 1) * ACCOUNT_ORDERS_PAGE_SIZE,
    with: { items: { columns: { id: true, sku: true, title: true, qty: true } } },
  });
  // Aggregate by displayed order (at most ACCOUNT_ORDERS_PAGE_SIZE binds),
  // never by item: a page of multi-item orders would exceed D1's bound
  // variable limit.
  const pageOrderIds = orderRows.map((o) => o.id);
  const returnedByItem = new Map<string, number>();
  if (pageOrderIds.length) {
    const marks = pageOrderIds.map(() => '?').join(',');
    const returnedRows = await db
      .prepare(
        `SELECT ri.order_item_id, COALESCE(SUM(ri.qty),0) AS q FROM return_items ri
         JOIN returns r ON r.id = ri.return_id
         WHERE r.user_id = ? AND r.status != 'rejected' AND r.order_id IN (${marks}) GROUP BY ri.order_item_id`
      )
      .bind(userId, ...pageOrderIds)
      .all<{ order_item_id: string; q: number }>();
    for (const r of returnedRows.results) returnedByItem.set(r.order_item_id, r.q);
  }
  const orders: AccountOrderRow[] = orderRows.map((o) => ({
    id: o.id,
    number: o.number,
    status: o.status,
    payment_status: o.paymentStatus,
    total_cents: o.totalCents,
    currency: o.currency,
    created_at: o.createdAt,
    tracking_number: o.trackingNumber,
    items: o.items.map((i) => ({ ...i, returned_qty: returnedByItem.get(i.id) ?? 0 })),
  }));
  const orderIds = orders.map((o) => o.id);
  const returns: AccountReturnRow[] = orderIds.length
    ? await d
        .select({
          id: returnsT.id,
          order_id: returnsT.orderId,
          status: returnsT.status,
          created_at: returnsT.createdAt,
        })
        .from(returnsT)
        .where(inArray(returnsT.orderId, orderIds))
        .orderBy(desc(returnsT.createdAt), desc(returnsT.id))
    : [];
  return { orders, returns, totalOrders, page: clamped, pageCount };
}

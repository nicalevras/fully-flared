import { grossSalePredicate } from './reports';
import { pageInputSchema, orderPagesSchema } from '../schemas/pagination';
import type { DiscountStatus, OrderStatus, PaymentStatus, ReturnStatus } from '../db/schema';
import * as z from 'zod';
import { pageSizeSchema } from '../schemas/pagination';
import { pageWindow } from '../lib/catalog-page';
import { ftsPhrase, ftsUsable } from '../lib/fts-search';
import { requireStaffPermission } from './session';

export type AdminOrderRow = {
  id: string;
  number: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  customer_email: string;
  total_cents: number;
  currency: string;
  created_at: string;
  refundable_cents: number;
  has_open_return: number;
};
export type AdminReturnRow = {
  id: string;
  order_id: string;
  number: string;
  reason: string;
  status: ReturnStatus;
  created_at: string;
  total_cents: number;
  currency: string;
  refundable_cents: number;
  refund_status: string | null;
};
const spendingSchema = z.array(z.object({ currency: z.string(), spent_cents: z.number() }));

type CustomerRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  created_at: number;
  orders: number;
  spending_json: string;
  last_order_at: string | null;
};
export async function adminCustomers(db: D1Database, input: unknown) {
  const { page } = pageInputSchema.parse(input);
  const rows = await db
    .prepare(
      `SELECT u.id,u.name,u.email,u.role,u.created_at,
    (SELECT COUNT(*) FROM orders WHERE user_id=u.id) AS orders,
    (SELECT json_group_array(json_object('currency',s.currency,'spent_cents',s.spent_cents)) FROM
      (SELECT currency,SUM(total_cents) AS spent_cents FROM orders sales WHERE sales.user_id=u.id AND ${grossSalePredicate('sales')} GROUP BY currency ORDER BY currency) s) AS spending_json,
    (SELECT MAX(created_at) FROM orders WHERE user_id=u.id) AS last_order_at
    FROM user u ORDER BY u.created_at DESC,u.id DESC LIMIT 200 OFFSET ?`
    )
    .bind((page - 1) * 200)
    .all<CustomerRow>();
  const count = await db.prepare('SELECT COUNT(*) AS n FROM user').first<{ n: number }>();
  return {
    customers: rows.results.map(({ spending_json, ...row }) => ({
      ...row,
      spending: spendingSchema.parse(JSON.parse(spending_json)),
    })),
    total: count?.n ?? 0,
    page,
  };
}
export async function adminOrders(db: D1Database, input: unknown) {
  const { page, returnsPage } = orderPagesSchema.parse(input);
  const refundable = `MAX(0,o.total_cents-COALESCE((SELECT SUM(amount_cents) FROM refunds WHERE order_id=o.id AND status NOT IN ('failed','canceled')),0))`;
  const [rows, rets, count, returnsCount] = await Promise.all([
    db
      .prepare(
        `SELECT o.id,o.number,o.status,o.payment_status,o.customer_email,o.total_cents,o.currency,o.created_at,${refundable} AS refundable_cents,EXISTS(SELECT 1 FROM returns r WHERE r.order_id=o.id AND r.status IN ('requested','approved','refund_failed')) AS has_open_return FROM orders o ORDER BY o.created_at DESC,o.id DESC LIMIT 100 OFFSET ?`
      )
      .bind((page - 1) * 100)
      .all<AdminOrderRow>(),
    db
      .prepare(
        `SELECT r.id,r.order_id,o.number,r.reason,r.status,r.created_at,o.total_cents,o.currency,${refundable} AS refundable_cents,
      (SELECT status FROM refunds WHERE return_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) AS refund_status
      FROM returns r JOIN orders o ON o.id=r.order_id WHERE r.status IN ('requested','refund_failed') ORDER BY (r.status='refund_failed') DESC, r.created_at ASC,r.id ASC LIMIT 50 OFFSET ?`
      )
      .bind((returnsPage - 1) * 50)
      .all<AdminReturnRow>(),
    db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM returns WHERE status IN ('requested','refund_failed')")
      .first<{ n: number }>(),
  ]);
  return {
    orders: rows.results,
    returns: rets.results,
    totalOrders: count?.n ?? 0,
    totalReturns: returnsCount?.n ?? 0,
    page,
    returnsPage,
  };
}

export type DiscountRow = {
  id: string;
  code: string;
  type: string;
  value: number;
  status: DiscountStatus;
  usage_count: number;
  min_purchase_cents: number;
  usage_limit: number | null;
  usage_per_customer: number;
  max_discount_cents: number | null;
  starts_at: string | null;
  expires_at: string | null;
};

export const discountListInputSchema = z.object({
  q: z.string().max(64).default(''),
  page: z.number().int().min(1).default(1),
  size: pageSizeSchema,
});

export async function adminDiscounts(
  db: D1Database,
  staff: { role?: string | null | undefined },
  input: z.infer<typeof discountListInputSchema>
) {
  requireStaffPermission(staff, 'discount', 'view');
  const q = input.q.trim().toUpperCase();
  // >= 3 chars: trigram FTS (substring, index-served). Shorter: prefix LIKE.
  const useFts = q ? ftsUsable(q) : false;
  const pattern = q && !useFts ? `${q.replace(/[\\%_]/g, '\\$&')}%` : null;
  const where = useFts
    ? 'WHERE rowid IN (SELECT rowid FROM discounts_fts WHERE discounts_fts MATCH ?)'
    : pattern
      ? "WHERE code LIKE ? ESCAPE '\\'"
      : '';
  const searchBind = useFts ? ftsPhrase(q) : pattern;
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM discounts ${where}`)
    .bind(...(searchBind ? [searchBind] : []))
    .first<{ n: number }>();
  const total = count?.n ?? 0;
  const { page, offset } = pageWindow(total, input.page, input.size);
  const rows = await db
    .prepare(
      `SELECT id, code, type, value, status, usage_count, min_purchase_cents, usage_limit, usage_per_customer, max_discount_cents, starts_at, expires_at FROM discounts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(...(searchBind ? [searchBind] : []), input.size, offset)
    .all<DiscountRow>();
  return { discounts: rows.results, total, page, pageSize: input.size };
}

import { grossSalePredicate } from './reports';
import type { ContactOrderRow } from './admin-contacts';
import type { ReturnStatus } from '../db/schema';

export type CustomerWorkspace = {
  profile: {
    id: string;
    name: string;
    email: string;
    role: string;
    created_at: number;
  } | null;
  orders: ContactOrderRow[];
  returns: Array<{
    id: string;
    order_id: string;
    number: string;
    status: ReturnStatus;
    reason: string;
    created_at: string;
  }>;
  totals: Array<{ currency: string; orders: number; spent_cents: number }>;
  latestAddress: { name: string | null; address_json: string | null } | null;
};

export async function getCustomerWorkspace(
  db: D1Database,
  userId: string
): Promise<CustomerWorkspace> {
  const profile = await db
    .prepare('SELECT id, name, email, role, created_at FROM user WHERE id = ?')
    .bind(userId)
    .first<CustomerWorkspace['profile']>();
  if (!profile) return { profile: null, orders: [], returns: [], totals: [], latestAddress: null };
  const [orders, returns, totals, latestAddress] = await Promise.all([
    db
      .prepare(
        `SELECT id, number, status, payment_status, total_cents, currency, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`
      )
      .bind(userId)
      .all<ContactOrderRow>(),
    db
      .prepare(
        `SELECT r.id, r.order_id, o.number, r.status, r.reason, r.created_at FROM returns r JOIN orders o ON o.id = r.order_id WHERE o.user_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 50`
      )
      .bind(userId)
      .all<CustomerWorkspace['returns'][number]>(),
    db
      .prepare(
        `SELECT currency, COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS spent_cents FROM orders o WHERE o.user_id = ? AND ${grossSalePredicate('o')} GROUP BY currency ORDER BY currency`
      )
      .bind(userId)
      .all<CustomerWorkspace['totals'][number]>(),
    db
      .prepare(
        `SELECT shipping_name AS name, shipping_address_json AS address_json FROM orders WHERE user_id = ? AND shipping_address_json IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .bind(userId)
      .first<CustomerWorkspace['latestAddress']>(),
  ]);
  return {
    profile,
    orders: orders.results,
    returns: returns.results,
    totals: totals.results,
    latestAddress: latestAddress ?? null,
  };
}

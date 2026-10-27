import { z } from 'zod';
import {
  decodeOrderSearchCursor,
  decodeReturnSearchCursor,
  normalizeOrderSearch,
  orderPaymentFilters,
  orderViews,
  type OrderSearchCursor,
  type ReturnSearchCursor,
} from '../lib/order-search';
import type { AdminOrderRow, AdminReturnRow } from './admin-lists';

export const orderDiscoveryInputSchema = z.object({
  q: z.string().max(200).default(''),
  view: z.enum(orderViews).default('queue'),
  payment: z.enum(orderPaymentFilters).default('all'),
  from: z.string().max(10).default(''),
  to: z.string().max(10).default(''),
  cursor: z.string().max(2000).optional(),
  returnsCursor: z.string().max(2000).optional(),
});
export type OrderDiscoveryInput = z.infer<typeof orderDiscoveryInputSchema>;

export type OrderDiscoveryResult = {
  orders: AdminOrderRow[];
  returns: AdminReturnRow[];
  nextCursor: string | null;
  previousCursor: string | null;
  returnsNextCursor: string | null;
  returnsPreviousCursor: string | null;
};

function encodeReturnCursor(
  input: OrderDiscoveryInput,
  row: { status: string; created_at: string; id: string },
  direction: ReturnSearchCursor['direction']
): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      kind: 'returns',
      q: input.q,
      view: input.view,
      payment: input.payment,
      from: input.from,
      to: input.to,
      failed: row.status === 'refund_failed' ? 1 : 0,
      key: row.created_at,
      id: row.id,
      direction,
    })
  );
  return btoa(String.fromCharCode(...bytes));
}

const PAGE_SIZE = 50;

function encodeCursor(
  input: OrderDiscoveryInput,
  row: { created_at: string; id: string },
  direction: OrderSearchCursor['direction']
): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      q: input.q,
      view: input.view,
      payment: input.payment,
      from: input.from,
      to: input.to,
      key: row.created_at,
      id: row.id,
      direction,
    })
  );
  return btoa(String.fromCharCode(...bytes));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export async function adminOrderDiscovery(
  db: D1Database,
  rawInput: unknown
): Promise<OrderDiscoveryResult> {
  const normalized = normalizeOrderSearch(rawInput);
  const input = orderDiscoveryInputSchema.parse(normalized);
  const cursor = decodeOrderSearchCursor(input.cursor, input);

  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (input.view === 'queue') {
    conditions.push("o.status IN ('paid','processing')");
  } else if (input.view === 'payment-issues') {
    conditions.push("o.payment_status IN ('failed','disputed')");
  }
  if (input.payment !== 'all') {
    conditions.push('o.payment_status = ?');
    binds.push(input.payment);
  }
  if (input.from) {
    conditions.push('o.created_at >= ?');
    binds.push(`${input.from}T00:00:00.000Z`);
  }
  if (input.to) {
    conditions.push("o.created_at < date(?, '+1 day')");
    binds.push(input.to);
  }
  if (input.q) {
    if (input.q.includes('@')) {
      conditions.push("o.customer_email LIKE ? ESCAPE '\\'");
      binds.push(`${escapeLike(input.q)}%`);
    } else {
      conditions.push("o.number LIKE ? ESCAPE '\\'");
      binds.push(`${escapeLike(input.q)}%`);
    }
  }

  const previous = cursor?.direction === 'previous';
  if (cursor) {
    if (previous) {
      conditions.push('(o.created_at > ? OR (o.created_at = ? AND o.id > ?))');
    } else {
      conditions.push('(o.created_at < ? OR (o.created_at = ? AND o.id < ?))');
    }
    binds.push(cursor.key, cursor.key, cursor.id);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const refundable = `MAX(0,o.total_cents-COALESCE((SELECT SUM(amount_cents) FROM refunds WHERE order_id=o.id AND status NOT IN ('failed','canceled')),0))`;
  const rows = (
    await db
      .prepare(
        `SELECT o.id,o.number,o.status,o.payment_status,o.customer_email,o.total_cents,o.currency,o.created_at,${refundable} AS refundable_cents,EXISTS(SELECT 1 FROM returns r WHERE r.order_id=o.id AND r.status IN ('requested','approved','refund_failed')) AS has_open_return FROM orders o ${where} ORDER BY o.created_at ${previous ? 'ASC' : 'DESC'}, o.id ${previous ? 'ASC' : 'DESC'} LIMIT ${PAGE_SIZE + 1}`
      )
      .bind(...binds)
      .all<AdminOrderRow>()
  ).results;
  const ordered = previous ? [...rows].reverse() : rows;
  const hasMore = ordered.length > PAGE_SIZE;
  const page = hasMore ? (previous ? ordered.slice(1) : ordered.slice(0, PAGE_SIZE)) : ordered;
  const first = page[0];
  const last = page[page.length - 1];
  const nextCursor = last && (previous || hasMore) ? encodeCursor(input, last, 'next') : null;
  const previousCursor =
    first && (previous ? hasMore : Boolean(cursor)) ? encodeCursor(input, first, 'previous') : null;

  // FF-03: the returns view paginates on its own keyset cursor, ordered
  // failed-first then oldest first, so every open return is reachable.
  let returns: AdminReturnRow[] = [];
  let returnsNextCursor: string | null = null;
  let returnsPreviousCursor: string | null = null;
  if (input.view === 'returns') {
    const returnCursor = decodeReturnSearchCursor(input.returnsCursor, input);
    const returnPrevious = returnCursor?.direction === 'previous';
    const returnConditions: string[] = ["r.status IN ('requested','refund_failed')"];
    const returnBinds: unknown[] = [];
    if (returnCursor) {
      if (returnPrevious) {
        returnConditions.push(
          "((r.status='refund_failed') > ? OR ((r.status='refund_failed') = ? AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?))))"
        );
      } else {
        returnConditions.push(
          "((r.status='refund_failed') < ? OR ((r.status='refund_failed') = ? AND (r.created_at > ? OR (r.created_at = ? AND r.id > ?))))"
        );
      }
      returnBinds.push(
        returnCursor.failed,
        returnCursor.failed,
        returnCursor.key,
        returnCursor.key,
        returnCursor.id
      );
    }
    const returnRows = (
      await db
        .prepare(
          `SELECT r.id,r.order_id,o.number,r.reason,r.status,r.created_at,o.total_cents,o.currency,${refundable} AS refundable_cents,
        (SELECT status FROM refunds WHERE return_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1) AS refund_status
        FROM returns r JOIN orders o ON o.id=r.order_id WHERE ${returnConditions.join(' AND ')} ORDER BY (r.status='refund_failed') ${returnPrevious ? 'ASC' : 'DESC'}, r.created_at ${returnPrevious ? 'DESC' : 'ASC'}, r.id ${returnPrevious ? 'DESC' : 'ASC'} LIMIT ${PAGE_SIZE + 1}`
        )
        .bind(...returnBinds)
        .all<AdminReturnRow>()
    ).results;
    const orderedReturns = returnPrevious ? [...returnRows].reverse() : returnRows;
    const returnsHasMore = orderedReturns.length > PAGE_SIZE;
    returns = returnsHasMore
      ? returnPrevious
        ? orderedReturns.slice(1)
        : orderedReturns.slice(0, PAGE_SIZE)
      : orderedReturns;
    const firstReturn = returns[0];
    const lastReturn = returns[returns.length - 1];
    returnsNextCursor =
      lastReturn && (returnPrevious || returnsHasMore)
        ? encodeReturnCursor(input, lastReturn, 'next')
        : null;
    returnsPreviousCursor =
      firstReturn && (returnPrevious ? returnsHasMore : Boolean(returnCursor))
        ? encodeReturnCursor(input, firstReturn, 'previous')
        : null;
  }
  return {
    orders: page,
    returns,
    nextCursor,
    previousCursor,
    returnsNextCursor,
    returnsPreviousCursor,
  };
}

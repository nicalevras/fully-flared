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
import { ftsPhrase, ftsUsable, escapeLike } from '../lib/fts-search';

export const orderDiscoveryInputSchema = z.object({
  q: z.string().max(200).default(''),
  mode: z.enum(['number', 'email']).default('number'),
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
      mode: input.mode,
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
      mode: input.mode,
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

/** Order numbers are `ORD-YYMMDD-XXXXXX` with YYMMDD the UTC order date, so a query
 *  shaped like their start is a number range inside a created_at window. */
const ORDER_NUMBER_PREFIX = /^ORD(?:-(\d{6}-[0-9]*|\d{0,6}))?$/;

function prefixEnd(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

/** created_at bounds for numbers starting `ORD-<digits>`. checkout.ts stamps created_at
 *  before it draws the number, so created_at can fall a day before the number's date. */
function createdAtWindow(digits: string) {
  if (!digits) return null;
  const yy = digits.slice(0, 2);
  const mm = digits.slice(2, 4);
  const dd = digits.slice(4, 6);
  const isoPrefix = `20${yy}${mm ? `-${mm}` : ''}${dd ? `-${dd}` : ''}`;
  const pad = (part: string) => Number(part.padEnd(2, '0'));
  const lowest = Date.UTC(2000 + pad(yy), pad(mm) - 1, pad(dd) - 1);
  return { from: new Date(lowest).toISOString(), to: prefixEnd(isoPrefix) };
}

export async function adminOrderDiscovery(
  db: D1Database,
  rawInput: unknown
): Promise<OrderDiscoveryResult> {
  const normalized = normalizeOrderSearch(rawInput);
  const input = orderDiscoveryInputSchema.parse(normalized);
  const cursor = decodeOrderSearchCursor(input.cursor, input);
  // A prefix into a day's suffixes sorts its few matches from the number index. Any
  // other walks the created_at index newest first inside the window its date
  // digits allow, and stops after one page.
  const numberPrefix = ORDER_NUMBER_PREFIX.exec(input.q);
  const dateDigits = numberPrefix?.[1]?.slice(0, 6) ?? '';
  const bySuffix = (numberPrefix?.[1]?.length ?? 0) > 7;
  const orderIndex = !numberPrefix
    ? ''
    : bySuffix
      ? 'INDEXED BY orders_number_unique'
      : 'INDEXED BY orders_created_id_idx';

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
  if (numberPrefix) {
    conditions.push('o.number >= ? AND o.number < ?');
    binds.push(input.q, prefixEnd(input.q));
    const window = bySuffix ? null : createdAtWindow(dateDigits);
    if (window) {
      conditions.push('o.created_at >= ? AND o.created_at < ?');
      binds.push(window.from, window.to);
    }
  } else if (input.q) {
    if (ftsUsable(input.q)) {
      // Trigram FTS: substring match on the order number, index-served.
      conditions.push('o.rowid IN (SELECT rowid FROM orders_fts WHERE orders_fts MATCH ?)');
      binds.push(`number : ${ftsPhrase(input.q)}`);
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
        `SELECT o.id,o.number,o.status,o.payment_status,o.customer_email,o.total_cents,o.currency,o.created_at,${refundable} AS refundable_cents,EXISTS(SELECT 1 FROM returns r WHERE r.order_id=o.id AND r.status IN ('requested','approved','refund_failed')) AS has_open_return FROM orders o ${orderIndex} ${where} ORDER BY o.created_at ${previous ? 'ASC' : 'DESC'}, o.id ${previous ? 'ASC' : 'DESC'} LIMIT ${PAGE_SIZE + 1}`
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

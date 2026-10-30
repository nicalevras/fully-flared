// Inventory holds: atomic conditional updates on D1, append-only ledger.
// No coordinator object: D1 serialises writes and batch() is transactional.
// Every stock mutation is a single db.batch whose statements are conditional
// on the reservation still being in the expected state, so a replay or a
// concurrent transition can never double-apply. Reservation creation is
// all-or-nothing: conditional updates gate the reservation and ledger
// inserts, and a final batch_guard insert (migration 0008) aborts the batch
// if any line failed. There are no MAX(...,0) clamps on counters: the
// conditional updates simply do not land when stock is insufficient, and
// the guard triggers in migration 0004 reject negative counters.

import { recoveryContext, reservationDue, type RecoveryContext } from './recovery-eligibility';

export type StockItem = { sku: string; qty: number };

/** Restock the units that were actually sold and that no return has already
 *  put back, once for the whole order. */
export function restockOrderStatements(
  db: D1Database,
  orderId: string,
  gate: { sql: string; values: (string | number | null)[] }
): D1PreparedStatement[] {
  const timestamp = new Date().toISOString();
  const eligible = `EXISTS(SELECT 1 FROM orders WHERE id=? AND restocked_at IS NULL) AND ${gate.sql}`;
  const returned = `COALESCE((SELECT SUM(ri.qty) FROM returns rt JOIN return_items ri ON ri.return_id=rt.id
      WHERE rt.order_id=r.order_id AND ri.sku=r.sku AND EXISTS(SELECT 1 FROM stock_ledger WHERE id='return-item-'||ri.id)),0)`;
  return [
    db
      .prepare(
        `INSERT INTO stock_ledger(id,sku,delta_on_hand,reason,ref_type,ref_id,created_at)
      SELECT 'return-sale-'||r.order_id||'-'||r.sku,r.sku,SUM(r.qty)-${returned},'return','order',r.order_id,? FROM reservations r
      WHERE r.order_id=? AND r.status='committed' AND ${eligible} GROUP BY r.sku HAVING SUM(r.qty)>${returned}`
      )
      .bind(timestamp, orderId, orderId, ...gate.values),
    db
      .prepare(
        `UPDATE stock SET on_hand=on_hand+COALESCE((SELECT delta_on_hand FROM stock_ledger WHERE id='return-sale-'||?||'-'||stock.sku),0),updated_at=?
      WHERE sku IN(SELECT sku FROM reservations WHERE order_id=? AND status='committed') AND ${eligible}`
      )
      .bind(orderId, timestamp, orderId, orderId, ...gate.values),
    db
      .prepare(
        `UPDATE orders SET restocked_at=? WHERE id=? AND restocked_at IS NULL AND ${gate.sql}`
      )
      .bind(timestamp, orderId, ...gate.values),
  ];
}

/** Restock exactly the items and quantities of one return, once per return
 *  item: the ledger row id is derived from the return item, and the counter
 *  update skips items whose ledger row already exists. An order that a full
 *  refund already restocked has nothing left to put back. */
export function restockReturnStatements(
  db: D1Database,
  returnId: string,
  gate: { sql: string; values: (string | number | null)[] }
): D1PreparedStatement[] {
  const timestamp = new Date().toISOString();
  const pending = `ri.return_id=? AND NOT EXISTS(SELECT 1 FROM stock_ledger WHERE id='return-item-'||ri.id) AND EXISTS(SELECT 1 FROM returns rt JOIN orders o ON o.id=rt.order_id WHERE rt.id=ri.return_id AND o.restocked_at IS NULL) AND ${gate.sql}`;
  return [
    db
      .prepare(
        `UPDATE stock SET on_hand=on_hand+(SELECT SUM(ri.qty) FROM return_items ri WHERE ri.sku=stock.sku AND ${pending}),updated_at=?
      WHERE sku IN(SELECT ri.sku FROM return_items ri WHERE ${pending})`
      )
      .bind(returnId, ...gate.values, timestamp, returnId, ...gate.values),
    db
      .prepare(
        `INSERT INTO stock_ledger(id,sku,delta_on_hand,reason,ref_type,ref_id,created_at)
      SELECT 'return-item-'||ri.id,ri.sku,ri.qty,'return','return',ri.return_id,? FROM return_items ri WHERE ${pending}`
      )
      .bind(timestamp, returnId, ...gate.values),
  ];
}

/** Release all current holds under the caller's transaction claim. */
export function releaseOrderHoldsStmts(
  db: D1Database,
  orderId: string,
  gate: { sql: string; values: (string | number | null)[] }
): D1PreparedStatement[] {
  const timestamp = new Date().toISOString();
  return [
    db
      .prepare(
        `INSERT INTO stock_ledger(id,sku,delta_reserved,reason,ref_type,ref_id,created_at) SELECT 'release-'||id,sku,-qty,'release','reservation',id,? FROM reservations WHERE order_id=? AND status='active' AND ${gate.sql}`
      )
      .bind(timestamp, orderId, ...gate.values),
    db
      .prepare(
        `UPDATE stock SET reserved=reserved-COALESCE((SELECT SUM(qty) FROM reservations WHERE order_id=? AND sku=stock.sku AND status='active'),0),updated_at=? WHERE sku IN(SELECT sku FROM reservations WHERE order_id=? AND status='active') AND ${gate.sql}`
      )
      .bind(orderId, timestamp, orderId, ...gate.values),
    db
      .prepare(
        `UPDATE reservations SET status='released' WHERE order_id=? AND status='active' AND ${gate.sql}`
      )
      .bind(orderId, ...gate.values),
  ];
}

export class InsufficientStock extends Error {
  constructor(public sku: string) {
    super(`Insufficient stock for ${sku}`);
  }
}

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

export function reservationStatements(
  db: D1Database,
  items: StockItem[],
  ref: { cartId?: string; orderId?: string; holdMinutes?: number }
) {
  // Merge duplicate SKUs so the conditional update sees the full quantity.
  const merged = new Map<string, number>();
  for (const i of items) merged.set(i.sku, (merged.get(i.sku) ?? 0) + i.qty);
  for (const [sku, qty] of merged) {
    if (!Number.isInteger(qty) || qty < 1) throw new InsufficientStock(sku);
  }

  const expiresAt = new Date(Date.now() + (ref.holdMinutes ?? 30) * 60_000).toISOString();
  const reservationIds: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const [sku, qty] of merged) {
    const reservationId = id();
    reservationIds.push(reservationId);
    // One batch, all-or-nothing: the stock update is conditional on
    // availability (or backorder); the reservation insert only lands when
    // that update changed a row, and the ledger insert only when the
    // reservation landed (changes() gating, as in the transition helpers).
    stmts.push(
      db
        .prepare(
          `UPDATE stock SET reserved = reserved + ?, updated_at = ?
           WHERE sku = ? AND (
             on_hand - reserved >= ?
             OR (SELECT continue_selling FROM variants WHERE variants.sku = stock.sku) = 1
           )`
        )
        .bind(qty, now(), sku, qty),
      db
        .prepare(
          `INSERT INTO reservations (id, cart_id, order_id, sku, qty, status, expires_at, created_at)
           SELECT ?, ?, ?, ?, ?, 'active', ?, ? WHERE (SELECT changes()) > 0`
        )
        .bind(reservationId, ref.cartId ?? null, ref.orderId ?? null, sku, qty, expiresAt, now()),
      db
        .prepare(
          `INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, ref_type, ref_id, created_at)
           SELECT ?, ?, 0, ?, 'reserve', ?, ?, ? WHERE (SELECT changes()) > 0`
        )
        .bind(
          id(),
          sku,
          qty,
          ref.orderId ? 'order' : 'cart',
          ref.orderId ?? ref.cartId ?? '',
          now()
        )
    );
  }
  // Final guard: if any line failed, its reservation is missing, so this
  // insert is attempted against batch_guard (CHECK (0)) and aborts the
  // whole batch. When every line landed, the WHERE is false and nothing
  // is inserted. There is no compensating second batch and no crash window.
  // Keep IDs plus the expected count below D1's 100-parameter limit.
  // All guards remain in the same transaction, so any missing line rolls back all.
  for (let offset = 0; offset < reservationIds.length; offset += 90) {
    const chunk = reservationIds.slice(offset, offset + 90);
    const placeholders = chunk.map(() => '?').join(',');
    stmts.push(
      db
        .prepare(
          `INSERT INTO batch_guard (id)
        SELECT 'reserve-failed' WHERE (SELECT COUNT(*) FROM reservations WHERE id IN (${placeholders})) != ?`
        )
        .bind(...chunk, chunk.length)
    );
  }

  return { reservationIds, stmts };
}

/** Set-based equivalent of reservationStatements for order initiation
 *  (Phase 2): a constant number of statements regardless of basket size,
 *  using bound JSON + json_each. Semantics are identical — conditional
 *  per-row stock update, cardinality guard on changes(), reservations
 *  and ledger derived from the same merged lines — and everything stays
 *  in the caller's single batch, so a guard failure rolls back all. */
export function reservationStatementsSetBased(
  db: D1Database,
  items: StockItem[],
  ref: { orderId: string; holdMinutes?: number }
) {
  const merged = new Map<string, number>();
  for (const i of items) merged.set(i.sku, (merged.get(i.sku) ?? 0) + i.qty);
  for (const [sku, qty] of merged) {
    if (!Number.isInteger(qty) || qty < 1) throw new InsufficientStock(sku);
  }
  const expiresAt = new Date(Date.now() + (ref.holdMinutes ?? 30) * 60_000).toISOString();
  const at = now();
  const lines = [...merged].map(([sku, qty]) => ({ reservationId: id(), sku, qty }));
  const linesJson = JSON.stringify(lines);
  const qtyFor = `(SELECT CAST(json_extract(value, '$.qty') AS INTEGER) FROM json_each(?) WHERE json_extract(value, '$.sku') = stock.sku)`;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE stock SET reserved = reserved + ${qtyFor}, updated_at = ?
         WHERE sku IN (SELECT json_extract(value, '$.sku') FROM json_each(?))
           AND (on_hand - reserved >= ${qtyFor}
             OR (SELECT continue_selling FROM variants WHERE variants.sku = stock.sku) = 1)`
      )
      .bind(linesJson, at, linesJson, linesJson),
    // Any line that failed its conditional update (or has no stock row)
    // makes the updated-row count differ: abort the whole batch.
    db
      .prepare(`INSERT INTO batch_guard (id) SELECT 'reserve-failed' WHERE (SELECT changes()) != ?`)
      .bind(lines.length),
    db
      .prepare(
        `INSERT INTO reservations (id, cart_id, order_id, sku, qty, status, expires_at, created_at)
         SELECT json_extract(value, '$.reservationId'), NULL, ?, json_extract(value, '$.sku'), CAST(json_extract(value, '$.qty') AS INTEGER), 'active', ?, ? FROM json_each(?)`
      )
      .bind(ref.orderId, expiresAt, at, linesJson),
    db
      .prepare(
        `INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, ref_type, ref_id, created_at)
         SELECT 'reserve-' || id, sku, 0, qty, 'reserve', 'order', order_id, ? FROM reservations WHERE order_id = ?`
      )
      .bind(at, ref.orderId),
  ];
  return { reservationIds: lines.map((l) => l.reservationId), stmts };
}

export async function reserveStock(
  db: D1Database,
  items: StockItem[],
  ref: { cartId?: string; orderId?: string; holdMinutes?: number }
): Promise<string[]> {
  const { reservationIds, stmts } = reservationStatements(db, items, ref);
  try {
    await db.batch(stmts);
  } catch (error) {
    if (error instanceof Error && /batch_guard|CHECK|reserved cannot/.test(error.message))
      throw new InsufficientStock(items[0]?.sku ?? 'item');
    throw error;
  }
  return reservationIds;
}

/** Statements that claim a reservation transition and move stock + ledger
 *  only if the claim in the immediately preceding statement actually landed.
 *  SQLite's changes() reflects the previous statement on the connection, and
 *  a D1 batch runs sequentially in one transaction, so gating each statement
 *  on `(SELECT changes()) > 0` makes replays and concurrent transitions
 *  no-ops instead of double-applies. */
export function releaseReservationStmts(
  db: D1Database,
  row: { id: string; sku: string; qty: number },
  transition?: { orderId: string; id: string }
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE reservations SET status = 'released' WHERE id = ? AND status = 'active' AND NOT EXISTS(SELECT 1 FROM checkout_intents ci WHERE ci.order_id=reservations.order_id AND ci.allocation_id IS NOT NULL AND ci.payment_state NOT IN ('canceled','finalized')) ${transition ? 'AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND transition_id = ?)' : ''}`
      )
      .bind(row.id, ...(transition ? [transition.orderId, transition.id] : [])),
    db
      .prepare(
        `UPDATE stock SET reserved = reserved - ?, updated_at = ? WHERE sku = ? AND (SELECT changes()) > 0`
      )
      .bind(row.qty, now(), row.sku),
    db
      .prepare(
        `INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, ref_type, ref_id, created_at)
         SELECT ?, ?, 0, ?, 'release', 'reservation', ?, ? WHERE (SELECT changes()) > 0`
      )
      .bind(id(), row.sku, -row.qty, row.id, now()),
  ];
}

export function commitReservationStmts(
  db: D1Database,
  row: { id: string; sku: string; qty: number },
  transition?: { orderId: string; id: string }
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE reservations SET status = 'committed' WHERE id = ? AND status = 'active' ${transition ? 'AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND transition_id = ?)' : ''}`
      )
      .bind(row.id, ...(transition ? [transition.orderId, transition.id] : [])),
    db
      .prepare(
        `UPDATE stock SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at = ? WHERE sku = ? AND (SELECT changes()) > 0`
      )
      .bind(row.qty, row.qty, now(), row.sku),
    db
      .prepare(
        `INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, ref_type, ref_id, created_at)
         SELECT ?, ?, ?, ?, 'sale', 'reservation', ?, ? WHERE (SELECT changes()) > 0`
      )
      .bind(id(), row.sku, -row.qty, -row.qty, row.id, now()),
  ];
}

export async function releaseReservation(db: D1Database, reservationId: string) {
  const row = await db
    .prepare('SELECT sku, qty FROM reservations WHERE id = ?')
    .bind(reservationId)
    .first<{ sku: string; qty: number }>();
  if (!row) return false;
  const result = await db.batch(
    releaseReservationStmts(db, { id: reservationId, sku: row.sku, qty: row.qty })
  );
  return (result[0]?.meta.changes ?? 0) > 0;
}

export async function commitReservation(db: D1Database, reservationId: string) {
  const row = await db
    .prepare('SELECT sku, qty FROM reservations WHERE id = ?')
    .bind(reservationId)
    .first<{ sku: string; qty: number }>();
  if (!row) return;
  await db.batch(commitReservationStmts(db, { id: reservationId, sku: row.sku, qty: row.qty }));
}

export async function releaseExpiredReservations(
  db: D1Database,
  limit = 100,
  context?: RecoveryContext
): Promise<number> {
  const due = reservationDue(context ?? (await recoveryContext(db)));
  const expired = await db
    .prepare(`SELECT r.id FROM reservations r WHERE ${due.sql} ORDER BY r.expires_at,r.id LIMIT ?`)
    .bind(...due.values, limit)
    .all<{ id: string }>();
  let released = 0;
  for (const r of expired.results) {
    // One bad row must not stall the whole sweep (and every later sweep).
    try {
      if (await releaseReservation(db, r.id)) released += 1;
    } catch (err) {
      console.error('hold expiry failed for reservation', r.id, err);
    }
  }
  return released;
}

export async function adjustStock(
  db: D1Database,
  sku: string,
  delta: number,
  reason: 'restock' | 'correction' | 'damaged' | 'return',
  extraStatements: D1PreparedStatement[] = []
) {
  // No clamp: a correction that would drive on_hand negative (without
  // backorder) aborts via the guard trigger and surfaces as an error.
  await db.batch([
    db
      .prepare('UPDATE stock SET on_hand = on_hand + ?, updated_at = ? WHERE sku = ?')
      .bind(delta, now(), sku),
    db
      .prepare(
        `INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, created_at)
         SELECT ?, ?, ?, 0, ?, ? WHERE changes()>0`
      )
      .bind(id(), sku, delta, reason, now()),
    db
      .prepare('INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM stock WHERE sku=?)')
      .bind(sku),
    ...extraStatements,
  ]);
}

export type StockAdjustmentOperation = {
  extraStatements?: D1PreparedStatement[];
  operationId: string;
  actorId: string;
  sku: string;
  delta: number;
  reason: 'restock' | 'correction' | 'damaged' | 'return';
  note?: string;
  expectedOnHand?: number;
};

export type StockAdjustmentOutcome =
  | { status: 'applied'; replayed: boolean; onHand: number; reserved: number }
  | { status: 'conflict'; error: string }
  | { status: 'missing-sku'; error: string };

async function payloadHash(op: StockAdjustmentOperation): Promise<string> {
  const canonical = JSON.stringify([op.actorId, op.sku, op.delta, op.reason, op.note ?? '']);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Replay-safe stock adjustment. The operation row, the counter update, and
 *  the ledger entry commit in one batch keyed by the client-supplied
 *  operation ID. A replay with the same payload returns the recorded outcome
 *  without adjusting twice; the same ID with a changed payload conflicts. */
export async function adjustStockIdempotent(
  db: D1Database,
  op: StockAdjustmentOperation
): Promise<StockAdjustmentOutcome> {
  const stockRow = await getStock(db, op.sku);
  if (!stockRow) return { status: 'missing-sku', error: `No stock record for SKU ${op.sku}` };
  const hash = await payloadHash(op);
  const timestamp = now();
  try {
    await db.batch([
      ...(op.expectedOnHand === undefined
        ? []
        : [
            db
              .prepare(
                'INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM stock WHERE sku = ? AND on_hand = ?)'
              )
              .bind(op.sku, op.expectedOnHand),
          ]),
      db
        .prepare(
          'INSERT INTO stock_operations (id, actor_id, sku, delta, reason, note, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          op.operationId,
          op.actorId,
          op.sku,
          op.delta,
          op.reason,
          op.note ?? null,
          hash,
          timestamp
        ),
      db
        .prepare('UPDATE stock SET on_hand = on_hand + ?, updated_at = ? WHERE sku = ?')
        .bind(op.delta, timestamp, op.sku),
      db
        .prepare(
          `INSERT INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, ref_type, ref_id, created_at)
           SELECT ?, ?, ?, 0, ?, 'stock_operation', ?, ? WHERE changes() > 0`
        )
        .bind(id(), op.sku, op.delta, op.reason, op.operationId, timestamp),
      db
        .prepare(
          'INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM stock WHERE sku = ?)'
        )
        .bind(op.sku),
      ...(op.extraStatements ?? []),
    ]);
  } catch {
    const existing = await db
      .prepare('SELECT payload_hash FROM stock_operations WHERE id = ?')
      .bind(op.operationId)
      .first<{ payload_hash: string }>();
    if (!existing) {
      const current = await getStock(db, op.sku);
      if (op.expectedOnHand !== undefined && current && current.on_hand !== op.expectedOnHand) {
        return {
          status: 'conflict',
          error: `Stock for ${op.sku} is now ${current.on_hand}, not ${op.expectedOnHand}. Reload before saving.`,
        };
      }
      throw new Error('Stock adjustment failed');
    }
    if (existing.payload_hash !== hash) {
      return {
        status: 'conflict',
        error:
          'This adjustment ID was already used with different details. Reload before retrying.',
      };
    }
    const current = await getStock(db, op.sku);
    return {
      status: 'applied',
      replayed: true,
      onHand: current?.on_hand ?? 0,
      reserved: current?.reserved ?? 0,
    };
  }
  const current = await getStock(db, op.sku);
  return {
    status: 'applied',
    replayed: false,
    onHand: current?.on_hand ?? 0,
    reserved: current?.reserved ?? 0,
  };
}

export async function getStock(db: D1Database, sku: string) {
  return db
    .prepare(
      'SELECT sku, on_hand, reserved, on_hand - reserved AS available FROM stock WHERE sku = ?'
    )
    .bind(sku)
    .first<{ sku: string; on_hand: number; reserved: number; available: number }>();
}

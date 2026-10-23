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

export type StockItem = { sku: string; qty: number };

/** Restock only units that were actually sold, once for the whole order. */
export function restockOrderStatements(
  db: D1Database,
  orderId: string,
  gate: { sql: string; values: (string | number | null)[] }
): D1PreparedStatement[] {
  const timestamp = new Date().toISOString();
  const eligible = `EXISTS(SELECT 1 FROM orders WHERE id=? AND restocked_at IS NULL) AND ${gate.sql}`;
  return [
    db
      .prepare(
        `INSERT INTO stock_ledger(id,sku,delta_on_hand,reason,ref_type,ref_id,created_at)
      SELECT 'return-sale-'||id,sku,qty,'return','order',order_id,? FROM reservations
      WHERE order_id=? AND status='committed' AND ${eligible}`
      )
      .bind(timestamp, orderId, orderId, ...gate.values),
    db
      .prepare(
        `UPDATE stock SET on_hand=on_hand+COALESCE((SELECT SUM(qty) FROM reservations WHERE order_id=? AND sku=stock.sku AND status='committed'),0),updated_at=?
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
        `UPDATE reservations SET status = 'released' WHERE id = ? AND status = 'active' AND NOT EXISTS(SELECT 1 FROM checkout_intents ci WHERE ci.order_id=reservations.order_id AND ci.flow='manual_capture' AND ci.allocation_id IS NOT NULL AND ci.payment_state NOT IN ('canceled','finalized')) ${transition ? 'AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND transition_id = ?)' : ''}`
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
  if (!row) return;
  await db.batch(releaseReservationStmts(db, { id: reservationId, sku: row.sku, qty: row.qty }));
}

export async function commitReservation(db: D1Database, reservationId: string) {
  const row = await db
    .prepare('SELECT sku, qty FROM reservations WHERE id = ?')
    .bind(reservationId)
    .first<{ sku: string; qty: number }>();
  if (!row) return;
  await db.batch(commitReservationStmts(db, { id: reservationId, sku: row.sku, qty: row.qty }));
}

export async function releaseExpiredReservations(db: D1Database, limit = 100): Promise<number> {
  const expired = await db
    .prepare(
      `SELECT id FROM reservations WHERE status = 'active' AND expires_at < ? AND NOT EXISTS(SELECT 1 FROM checkout_intents ci WHERE ci.order_id=reservations.order_id AND ci.flow='manual_capture' AND ci.allocation_id IS NOT NULL AND ci.payment_state NOT IN ('canceled','finalized')) ORDER BY expires_at LIMIT ?`
    )
    .bind(now(), limit)
    .all<{ id: string }>();
  let released = 0;
  for (const r of expired.results) {
    // One bad row must not stall the whole sweep (and every later sweep).
    try {
      await releaseReservation(db, r.id);
      released += 1;
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
  reason: 'restock' | 'correction' | 'damaged' | 'return'
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
  ]);
}

export async function getStock(db: D1Database, sku: string) {
  return db
    .prepare(
      'SELECT sku, on_hand, reserved, on_hand - reserved AS available FROM stock WHERE sku = ?'
    )
    .bind(sku)
    .first<{ sku: string; on_hand: number; reserved: number; available: number }>();
}

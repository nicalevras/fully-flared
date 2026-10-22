export type ReturnItemInput = {
  orderItemId: string;
  sku: string;
  title: string;
  qty: number;
  unitPriceCents: number;
};

/** Validate requested lines against the order: every line must belong to
 * the order and qty cannot exceed bought minus already returned (returns
 * that were not rejected). Returns snapshot rows ready to insert. */
export async function validateReturnItems(
  db: D1Database,
  orderId: string,
  requested: Array<{ orderItemId: string; qty: number }>
): Promise<{ ok: true; items: ReturnItemInput[] } | { ok: false; error: string }> {
  const lines = await db
    .prepare('SELECT id, sku, title, qty, unit_price_cents FROM order_items WHERE order_id = ?')
    .bind(orderId)
    .all<{ id: string; sku: string; title: string; qty: number; unit_price_cents: number }>();
  const byId = new Map(lines.results.map((l) => [l.id, l]));
  const returnedRows = await db
    .prepare(
      `SELECT ri.order_item_id, COALESCE(SUM(ri.qty),0) AS q FROM return_items ri
       JOIN returns r ON r.id = ri.return_id
       WHERE r.order_id = ? AND r.status != 'rejected' GROUP BY ri.order_item_id`
    )
    .bind(orderId)
    .all<{ order_item_id: string; q: number }>();
  const alreadyReturned = new Map(returnedRows.results.map((r) => [r.order_item_id, r.q]));
  const seen = new Set<string>();
  const items: ReturnItemInput[] = [];
  for (const item of requested) {
    const line = byId.get(item.orderItemId);
    if (!line || seen.has(item.orderItemId))
      return { ok: false, error: 'Return items do not match this order' };
    seen.add(item.orderItemId);
    const remaining = line.qty - (alreadyReturned.get(line.id) ?? 0);
    if (item.qty > remaining)
      return { ok: false, error: `Only ${remaining} of ${line.title} can still be returned` };
    items.push({
      orderItemId: line.id,
      sku: line.sku,
      title: line.title,
      qty: item.qty,
      unitPriceCents: line.unit_price_cents,
    });
  }
  return { ok: true, items };
}

/** The database index arbitrates requests that both passed the storefront precheck. */
export async function insertReturnRequest(
  db: D1Database,
  orderId: string,
  userId: string,
  reason: string,
  items: ReturnItemInput[] = []
) {
  const returnId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO returns (id, order_id, user_id, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(returnId, orderId, userId, reason, 'requested', now),
      ...items.map((item) =>
        db
          .prepare(
            'INSERT INTO return_items (id, return_id, order_item_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(
            crypto.randomUUID(),
            returnId,
            item.orderItemId,
            item.sku,
            item.title,
            item.qty,
            item.unitPriceCents
          )
      ),
    ]);
    return { ok: true as const, returnId };
  } catch (error) {
    if (
      /UNIQUE constraint failed: returns\.order_id/.test(
        error instanceof Error ? error.message : ''
      )
    )
      return { ok: false as const, error: 'A return is already in progress for this order' };
    if (
      /return quantity exceeds purchased quantity/.test(error instanceof Error ? error.message : '')
    )
      return {
        ok: false as const,
        error: 'Some items can no longer be returned in that quantity',
      };
    throw error;
  }
}

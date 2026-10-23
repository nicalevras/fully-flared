// Customer-account order ownership. Orders belong to an account by user_id
// only; guest orders are claimed solely after the account email is verified.
export async function claimVerifiedGuestOrders(
  db: D1Database,
  user: { id: string; email: string; emailVerified?: boolean }
): Promise<number> {
  if (!user.emailVerified) return 0;
  const result = await db
    .prepare('UPDATE orders SET user_id = ? WHERE customer_email = ? AND user_id IS NULL')
    .bind(user.id, user.email.toLowerCase())
    .run();
  return result.meta.changes ?? 0;
}

function parseJsonColumn(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Everything the store holds about one account, for the customer's own
 *  export and the admin export. Read-only. */
export async function exportCustomerData(db: D1Database, userId: string) {
  const [profile, orders, orderItems, addresses, returns, returnItems] = await Promise.all([
    db
      .prepare(
        'SELECT id, name, email, email_verified AS emailVerified, role, created_at AS createdAt FROM user WHERE id = ?'
      )
      .bind(userId)
      .first(),
    db
      .prepare(
        'SELECT id, number, status, payment_status AS paymentStatus, subtotal_cents AS subtotalCents, discount_cents AS discountCents, shipping_cents AS shippingCents, tax_cents AS taxCents, total_cents AS totalCents, currency, shipping_name AS shippingName, shipping_address_json, created_at AS createdAt FROM orders WHERE user_id = ? ORDER BY created_at, id'
      )
      .bind(userId)
      .all<Record<string, unknown> & { id: string; shipping_address_json: string | null }>(),
    db
      .prepare(
        'SELECT oi.order_id AS orderId, oi.sku, oi.title, oi.qty, oi.unit_price_cents AS unitPriceCents FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = ? ORDER BY oi.rowid'
      )
      .bind(userId)
      .all<Record<string, unknown> & { orderId: string }>(),
    db
      .prepare(
        'SELECT id, label, name, line1, line2, city, state, postal_code AS postalCode, country, phone, is_default AS isDefault FROM addresses WHERE user_id = ?'
      )
      .bind(userId)
      .all(),
    db
      .prepare(
        'SELECT id, order_id AS orderId, status, reason, created_at AS createdAt FROM returns WHERE user_id = ? ORDER BY created_at, id'
      )
      .bind(userId)
      .all<Record<string, unknown> & { id: string }>(),
    db
      .prepare(
        'SELECT ri.return_id AS returnId, ri.sku, ri.title, ri.qty, ri.unit_price_cents AS unitPriceCents FROM return_items ri JOIN returns r ON r.id = ri.return_id WHERE r.user_id = ? ORDER BY ri.rowid'
      )
      .bind(userId)
      .all<Record<string, unknown> & { returnId: string }>(),
  ]);
  if (!profile) return null;
  return {
    profile,
    orders: orders.results.map(({ shipping_address_json, ...order }) => ({
      ...order,
      shippingAddress: parseJsonColumn(shipping_address_json),
      items: orderItems.results.filter((item) => item.orderId === order.id),
    })),
    addresses: addresses.results,
    returns: returns.results.map((ret) => ({
      ...ret,
      items: returnItems.results.filter((item) => item.returnId === ret.id),
    })),
  };
}

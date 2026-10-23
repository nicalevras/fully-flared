/** Test fixture attachment; production attachment is fenced. */
export async function attachStripeSession(db: D1Database, orderId: string, sessionId: string) {
  await db
    .prepare('UPDATE orders SET stripe_checkout_session_id=?,updated_at=? WHERE id=?')
    .bind(sessionId, new Date().toISOString(), orderId)
    .run();
}

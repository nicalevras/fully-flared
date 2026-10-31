// Customer-account order ownership. Orders belong to an account by user_id
// only; guest orders are claimed solely after the account email is verified.
export async function claimVerifiedGuestOrders(
  db: D1Database,
  user: { id: string; email: string; emailVerified?: boolean }
): Promise<number> {
  if (!user.emailVerified) return 0;
  const result = await db
    .prepare('UPDATE orders SET user_id = ? WHERE lower(customer_email) = ? AND user_id IS NULL')
    .bind(user.id, user.email.toLowerCase())
    .run();
  return result.meta.changes ?? 0;
}

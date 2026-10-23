import { cancelOrdersStatements } from './order-cancellation';

export class AccountDeletionError extends Error {
  constructor(
    public status: 404 | 409,
    message: string
  ) {
    super(message);
  }
}

/** The role guard, eligible checkout cancellation, reservation/coupon
 *  release, intent retirement, privacy cleanup and user deletion share
 *  one guarded D1 batch. D1 batches are atomic, so a guard rejection —
 *  including a promotion that lands before the batch executes — or any
 *  later failure rolls back every cancellation and scrub: a rejected
 *  or failed deletion has zero commerce side effects. */
export async function deleteAccountAtomically(
  db: D1Database,
  userId: string,
  actorId?: string
): Promise<void> {
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM user WHERE id=? AND role NOT IN ('owner','admin'))"
        )
        .bind(userId),
      ...cancelOrdersStatements(db, { sql: 'user_id=?', values: [userId] }),
      // Retire checkout-intent replay authorization and scrub the frozen
      // provider payload (it embeds the email); intents never become
      // guest-owned. Nulling user_id here also satisfies the FK before
      // the user row is deleted below.
      db
        .prepare(
          "UPDATE checkout_intents SET user_id=NULL, guest_capability_hash=NULL, claim_token=NULL, claim_expires_at=NULL, shipping_address_json=NULL, creation_stopped_at=COALESCE(creation_stopped_at,datetime('now')), provider_payload_json='{}', state = CASE WHEN flow='legacy' AND state IN ('reserved', 'session_creating', 'reconciliation_required', 'ready') THEN 'canceled' ELSE state END WHERE user_id=? OR order_id IN(SELECT id FROM orders WHERE user_id=?)"
        )
        .bind(userId, userId),
      db
        .prepare(
          "UPDATE orders SET user_id=NULL,customer_email='deleted@invalid',shipping_name=NULL,shipping_address_json=NULL,customer_ip=NULL WHERE user_id=?"
        )
        .bind(userId),
      db.prepare('DELETE FROM addresses WHERE user_id=?').bind(userId),
      db.prepare('UPDATE carts SET user_id=NULL,customer_email=NULL WHERE user_id=?').bind(userId),
      db.prepare('UPDATE returns SET user_id=NULL WHERE user_id=?').bind(userId),
      db.prepare('UPDATE posts SET author_id=NULL WHERE author_id=?').bind(userId),
      db.prepare('DELETE FROM user WHERE id=?').bind(userId),
      ...(actorId
        ? [
            db
              .prepare(
                "INSERT INTO audit_log(id,actor_user_id,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,'customer.delete','user',?,'{}',?)"
              )
              .bind(crypto.randomUUID(), actorId, userId, new Date().toISOString()),
          ]
        : []),
    ]);
  } catch {
    // Classification happens after rollback; it never authorizes a destructive write.
    try {
      const current = await db
        .prepare('SELECT role FROM user WHERE id=?')
        .bind(userId)
        .first<{ role: string }>();
      if (!current) throw new AccountDeletionError(404, 'Account not found');
      if (current.role === 'owner' || current.role === 'admin')
        throw new AccountDeletionError(
          409,
          'Another owner must demote this account before it can be deleted.'
        );
    } catch (error) {
      if (error instanceof AccountDeletionError) throw error;
    }
    console.error(JSON.stringify({ event: 'account_deletion_failed' }));
    throw new Error('Account deletion failed. Please try again.');
  }
}

import type { AccountAction } from '../schemas/account';

type AddressInput = Extract<AccountAction, { action: 'address.create' | 'address.update' }>;

/** Create or update an address, moving the default flag atomically.
 * Update: target write, existence guard, then clearing other defaults —
 * one batch, so a missing/foreign/concurrently deleted address (or any
 * failure after the target write) rolls everything back and the current
 * default survives. Only the guard translates to "Address not found";
 * other failures are logged structured and rethrown as generic errors. */
export async function saveAddress(
  db: D1Database,
  userId: string,
  data: AddressInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  const isDefault = data.isDefault ? 1 : 0;
  try {
    if (data.action === 'address.create') {
      const addressId = crypto.randomUUID();
      const statements = [
        db
          .prepare(
            `INSERT INTO addresses (id, user_id, name, line1, line2, city, state, postal_code, country, phone, is_default)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            addressId,
            userId,
            data.name,
            data.line1,
            data.line2,
            data.city,
            data.region,
            data.postalCode,
            data.country,
            data.phone,
            isDefault
          ),
      ];
      if (isDefault)
        statements.push(
          db
            .prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ? AND id != ?')
            .bind(userId, addressId)
        );
      await db.batch(statements);
    } else {
      const existing = await db
        .prepare('SELECT id FROM addresses WHERE id = ? AND user_id = ?')
        .bind(data.addressId, userId)
        .first();
      if (!existing) return { ok: false, error: 'Address not found' };
      const statements = [
        db
          .prepare(
            `UPDATE addresses SET name = ?, line1 = ?, line2 = ?, city = ?, state = ?, postal_code = ?, country = ?, phone = ?, is_default = ?
             WHERE id = ? AND user_id = ?`
          )
          .bind(
            data.name,
            data.line1,
            data.line2,
            data.city,
            data.region,
            data.postalCode,
            data.country,
            data.phone,
            isDefault,
            data.addressId,
            userId
          ),
        db
          .prepare(
            'INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM addresses WHERE id = ? AND user_id = ?)'
          )
          .bind(data.addressId, userId),
      ];
      if (isDefault)
        statements.push(
          db
            .prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ? AND id != ?')
            .bind(userId, data.addressId)
        );
      await db.batch(statements);
    }
  } catch (error) {
    // D1's guard-abort message does not name the guard table, so detect
    // the not-found case by re-checking existence: a batch failure with
    // the target gone is the guard (or the precheck race); a failure with
    // the target still present is a generic error and is rethrown.
    if (data.action === 'address.update') {
      // A failed recheck is itself an error, never proof of absence:
      // only a successful lookup returning no row means not-found.
      let stillThere: Awaited<ReturnType<D1PreparedStatement['first']>>;
      try {
        stillThere = await db
          .prepare('SELECT id FROM addresses WHERE id = ? AND user_id = ?')
          .bind(data.addressId, userId)
          .first();
      } catch (lookupError) {
        console.error(
          JSON.stringify({
            event: 'address_action_failed',
            action: data.action,
            error: lookupError instanceof Error ? lookupError.message : String(lookupError),
          })
        );
        throw lookupError;
      }
      if (!stillThere) return { ok: false, error: 'Address not found' };
    }
    console.error(
      JSON.stringify({
        event: 'address_action_failed',
        action: data.action,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    throw error;
  }
  return { ok: true };
}

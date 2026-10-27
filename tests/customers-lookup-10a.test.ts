import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import {
  contactHistory,
  lookupContact,
  normalizeContactEmail,
} from '../web/src/server/admin-contacts';

let db: D1Database, dispose: () => Promise<void>;

async function insertOrder(id: string, userId: string | null, email: string) {
  await db
    .prepare(
      `INSERT INTO orders (id, number, status, payment_status, customer_email, user_id, currency, subtotal_cents, total_cents, created_at, updated_at)
       VALUES (?, ?, 'paid', 'paid', ?, ?, 'USD', 1000, 1000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    )
    .bind(id, `FF-${id}`, email, userId)
    .run();
}

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await db
    .prepare(
      "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('u1', 'Ada', 'Ada@Example.com', 1, 'customer', 1, 1)"
    )
    .run();
  await insertOrder('a1', 'u1', 'ada@example.com');
  await insertOrder('g1', null, 'ADA@example.com');
  await insertOrder('g2', null, 'other@example.com');
});
afterEach(async () => {
  await dispose();
});

describe('Phase 10A contact lookup', () => {
  it('normalizes by trim and case fold only', () => {
    expect(normalizeContactEmail('  Ada.Lovelace+Shop@Example.COM ')).toBe(
      'ada.lovelace+shop@example.com'
    );
  });

  it('counts account and guest records separately for the same email', async () => {
    const lookup = await lookupContact(db, ' ada@example.com ');
    expect(lookup?.account?.id).toBe('u1');
    expect(lookup?.accountOrderCount).toBe(1);
    expect(lookup?.guestOrderCount).toBe(1);
  });

  it('never exposes guest orders inside account history', async () => {
    const history = await contactHistory(db, 'ada@example.com');
    expect(history.account.map((o) => o.id)).toEqual(['a1']);
    expect(history.guest.map((o) => o.id)).toEqual(['g1']);
  });

  it('returns an empty lookup for a blank email', async () => {
    expect(await lookupContact(db, '   ')).toBeNull();
  });
});

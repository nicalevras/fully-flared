import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { claimVerifiedGuestOrders } from '../web/src/server/account';
import { createAuth } from '../web/src/lib/auth';
import { z } from './helpers/json';

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
       VALUES ('victim-account', 'Victim', 'victim@example.com', 1, 'customer', ?, ?)`
      )
      .bind(Date.now(), Date.now()),
    db
      .prepare(
        `INSERT INTO orders (id, number, status, payment_status, customer_email, currency, subtotal_cents, total_cents, created_at, updated_at)
       VALUES ('guest-order', 'ORD-GUEST', 'paid', 'paid', 'victim@example.com', 'USD', 2000, 2000, ?, ?)`
      )
      .bind(now, now),
  ]);
});
afterAll(async () => {
  await dispose();
});

describe('guest order claiming', () => {
  it('an unverified account using the victim email claims and sees nothing', async () => {
    const claimed = await claimVerifiedGuestOrders(db, {
      id: 'attacker',
      email: 'Victim@Example.com',
      emailVerified: false,
    });
    expect(claimed).toBe(0);
    const row = await db
      .prepare('SELECT user_id FROM orders WHERE id = ?')
      .bind('guest-order')
      .first<{ user_id: string | null }>();
    expect(row?.user_id).toBeNull();
  });

  it('the verified owner of the email claims the guest order', async () => {
    const claimed = await claimVerifiedGuestOrders(db, {
      id: 'victim-account',
      email: 'Victim@Example.com',
      emailVerified: true,
    });
    expect(claimed).toBe(1);
    const row = await db
      .prepare('SELECT user_id FROM orders WHERE id = ?')
      .bind('guest-order')
      .first<{ user_id: string | null }>();
    expect(row?.user_id).toBe('victim-account');
  });
});

describe('auth configuration', () => {
  it('public signup with the owner email is an unverified customer, never the owner', async () => {
    const auth = createAuth(db, 'http://localhost:8799', 'test-secret-that-is-long-enough', [
      'boss@example.com',
    ]);
    const result = await auth.api.signUpEmail({
      body: { name: 'Attacker', email: 'boss@example.com', password: 'password123' },
    });
    expect(result.user.emailVerified).toBe(false);
    expect(z.object({ role: z.string() }).parse(result.user).role).toBe('customer');
    const row = await db
      .prepare('SELECT role, email_verified FROM user WHERE email = ?')
      .bind('boss@example.com')
      .first<{ role: string; email_verified: number }>();
    expect(row).toEqual({ role: 'customer', email_verified: 0 });
  });
});

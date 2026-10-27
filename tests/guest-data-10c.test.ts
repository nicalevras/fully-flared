import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';
import { erasedEmailFor, previewGuestData } from '../web/src/server/guest-data';

let db: D1Database, dispose: () => Promise<void>;
const owner = { id: 'owner', role: 'owner' };
const env = {} as Cloudflare.Env;

async function insertOrder(id: string, userId: string | null, email: string, name: string | null) {
  await db
    .prepare(
      `INSERT INTO orders (id, number, status, payment_status, customer_email, user_id, currency, subtotal_cents, total_cents, shipping_name, shipping_address_json, customer_ip, created_at, updated_at)
       VALUES (?, ?, 'paid', 'paid', ?, ?, 'USD', 1000, 1000, ?, '{"line1":"1 Main St"}', '203.0.113.9', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    )
    .bind(id, `FF-${id}`, email, userId, name)
    .run();
}

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await db
    .prepare(
      "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('u1', 'Ada', 'ada@example.com', 1, 'customer', 1, 1)"
    )
    .run();
  await insertOrder('a1', 'u1', 'ada@example.com', 'Ada');
  await insertOrder('g1', null, 'Ada@Example.com', 'Guest Ada');
});
afterEach(async () => {
  await dispose();
});

describe('Phase 10C guest export and erasure', () => {
  it('previews exactly the guest records and retained totals', async () => {
    const preview = await previewGuestData(db, ' ada@example.com ');
    expect(preview?.orderCount).toBe(1);
    expect(preview?.orders.map((o) => o.id)).toEqual(['g1']);
    expect(preview?.totals).toEqual([{ currency: 'USD', orders: 1, total_cents: 1000 }]);
  });

  it('exports guest purchases without account orders', async () => {
    const result = await runAdminAction(db, env, owner, 'guest.export', {
      email: 'ada@example.com',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { orders: Array<{ id: string }> };
      expect(data.orders.map((o) => o.id)).toEqual(['g1']);
    }
  });

  it('erases identifying guest details, retains financial facts, and never touches the account order', async () => {
    const result = await runAdminAction(db, env, owner, 'guest.erase', {
      email: 'ada@example.com',
    });
    expect(result.ok).toBe(true);
    const guest = await db
      .prepare(
        'SELECT customer_email, shipping_name, shipping_address_json, customer_ip, total_cents FROM orders WHERE id = ?'
      )
      .bind('g1')
      .first<{
        customer_email: string;
        shipping_name: string | null;
        shipping_address_json: string | null;
        customer_ip: string | null;
        total_cents: number;
      }>();
    expect(guest?.customer_email).toBe(await erasedEmailFor('ada@example.com'));
    expect(guest?.shipping_name).toBeNull();
    expect(guest?.shipping_address_json).toBeNull();
    expect(guest?.customer_ip).toBeNull();
    expect(guest?.total_cents).toBe(1000);
    const account = await db
      .prepare('SELECT customer_email FROM orders WHERE id = ?')
      .bind('a1')
      .first<{ customer_email: string }>();
    expect(account?.customer_email).toBe('ada@example.com');
    const again = await runAdminAction(db, env, owner, 'guest.erase', {
      email: 'ada@example.com',
    });
    expect(again.ok).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';
import { withOverrides } from './helpers/fixtures';
import { actionData, actionFailure, z } from './helpers/json';

let db: D1Database;
let env: Env;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  env = t.env;
  dispose = t.dispose;
  await seedProduct(db, { onHand: 5 });
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('cust-1', 'Casey', 'casey@example.com', 1, 'customer', ?, ?)"
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO orders (id, number, customer_email, user_id, currency, subtotal_cents, total_cents, status, payment_status, checkout_attempt_id, created_at, updated_at) VALUES ('ord-1', '1001', 'casey@example.com', 'cust-1', 'USD', 1000, 1000, 'paid', 'paid', 'k-cust-1', ?, ?)"
      )
      .bind(now, now),
  ]);
});
afterAll(async () => {
  await dispose();
});

describe('admin customer export and deletion', () => {
  it('exports the customer profile and order history', async () => {
    const result = await runAdminAction(
      db,
      env,
      { id: 'owner-1', role: 'owner' },
      'customer.export',
      { userId: 'cust-1' }
    );
    const data = actionData(
      result,
      z.object({
        profile: z.object({ email: z.string() }),
        orders: z.array(z.object({ number: z.string() })),
      })
    );
    expect(data.profile.email).toBe('casey@example.com');
    expect(data.orders.map((o) => o.number)).toEqual(['1001']);
  });

  it('support cannot export (403 permission gate)', async () => {
    const result = await runAdminAction(
      db,
      env,
      { id: 'sup-1', role: 'support' },
      'customer.export',
      { userId: 'cust-1' }
    );
    expect(actionFailure(result).status).toBe(403);
  });

  it('media.delete removes the original and every generated variant from R2 (B8)', async () => {
    const now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO media (id, r2_key, filename, content_type, alt_text, created_at) VALUES ('m1', 'img-1.jpg', 'img-1.jpg', 'image/jpeg', '', ?)"
      )
      .bind(now)
      .run();
    const deleted: string[] = [];
    const media = withOverrides(env.MEDIA, {
      delete: async (keys) => {
        deleted.push(...[keys].flat());
      },
    });
    const result = await runAdminAction(
      db,
      withOverrides(env, { MEDIA: media }),
      { id: 'owner-1', role: 'owner' },
      'media.delete',
      {
        mediaId: 'm1',
      }
    );
    expect(result.ok).toBe(true);
    expect(deleted.sort()).toEqual([
      'img-1.jpg',
      'img-1.w1600.jpg',
      'img-1.w320.jpg',
      'img-1.w640.jpg',
      'img-1.w960.jpg',
    ]);
    const row = await db.prepare("SELECT id FROM media WHERE id = 'm1'").first();
    expect(row).toBeNull();
  });

  it('deletion anonymizes orders and removes the identity atomically, retaining plugin permission checks', async () => {
    const removed: string[] = [];
    const fakeAuth = {
      api: {
        userHasPermission: async () => ({ success: true }),
        removeUser: async ({ body }: { body: { userId: string } }) => {
          removed.push(body.userId);
          await db.prepare('DELETE FROM user WHERE id = ?').bind(body.userId).run();
          return { success: true };
        },
      },
    };
    const result = await runAdminAction(
      db,
      env,
      { id: 'owner-1', role: 'owner' },
      'customer.delete',
      { userId: 'cust-1' },
      { auth: fakeAuth as never, headers: new Headers() }
    );
    expect(result.ok).toBe(true);
    expect(removed).toEqual([]);
    const order = await db
      .prepare("SELECT customer_email FROM orders WHERE id = 'ord-1'")
      .first<{ customer_email: string }>();
    expect(order?.customer_email).toBe('deleted@invalid');
    const user = await db.prepare("SELECT id FROM user WHERE id = 'cust-1'").first();
    expect(user).toBeNull();
  });
});

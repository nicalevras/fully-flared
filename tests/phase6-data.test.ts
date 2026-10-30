import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';
import { env } from './helpers/cloudflare-workers-stub';
import { deleteAccountAtomically } from '../web/src/server/account-deletion';
import { pruneRetention } from '../web/src/server/operations';
import { calculateDiscount } from '../web/src/server/checkout';

const session = vi.hoisted(() => ({
  user: { id: 'u1', name: 'Una', email: 'una@example.com', emailVerified: true },
}));
vi.mock('../web/src/server/session', async (original) => ({
  ...(await original<typeof import('../web/src/server/session')>()),
  getSessionUser: async () => session.user,
}));

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  env.DB = db;
});
afterEach(async () => {
  delete env.DB;
  await dispose();
});

const day = 24 * 60 * 60_000;
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

async function user(id: string, email: string) {
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES (?, 'U', ?, 1, 'customer', ?, ?)"
    )
    .bind(id, email, now, now)
    .run();
}
async function order(id: string, email: string, userId: string | null) {
  await db
    .prepare(
      `INSERT INTO orders(id,number,customer_email,user_id,subtotal_cents,total_cents,status,payment_status,shipping_address_json,created_at,updated_at) VALUES(?,?,?,?,1000,1000,'paid','paid','{"line1":"1 Main St"}',?,?)`
    )
    .bind(id, id, email, userId, iso(), iso())
    .run();
}
async function discount(id: string, perCustomer = 1) {
  await db
    .prepare(
      "INSERT INTO discounts(id,code,type,value,usage_per_customer,created_at) VALUES(?,?,'fixed',100,?,?)"
    )
    .bind(id, id.toUpperCase(), perCustomer, iso())
    .run();
}
async function usage(id: string, discountId: string, orderId: string, email: string) {
  await db
    .prepare(
      'INSERT INTO discount_usage(id,discount_id,order_id,customer_email,amount_cents,created_at) VALUES(?,?,?,?,100,?)'
    )
    .bind(id, discountId, orderId, email, iso())
    .run();
}
async function count(sql: string, ...values: unknown[]) {
  return (
    (
      await db
        .prepare(sql)
        .bind(...values)
        .first<{ c: number }>()
    )?.c ?? 0
  );
}

describe('M3: account deletion removes the email from side tables', () => {
  it('scrubs discount_usage, outbox, processed webhook_inbox and verification rows; dead letters keep their payload until the 90-day retention', async () => {
    const email = 'una@example.com';
    await user('u1', email);
    await order('o1', email, 'u1');
    await discount('d1');
    await usage('du1', 'd1', 'o1', email);
    const payload = JSON.stringify({ to: email, subject: 'Hi', text: 'hi', html: 'hi' });
    await db
      .prepare(
        "INSERT INTO outbox(id,type,payload_json,status,attempts,created_at) VALUES('ob-pending','email.send',?,'pending',0,?),('ob-sent','email.send',?,'sent',1,?)"
      )
      .bind(payload, iso(), payload, iso())
      .run();
    const event = JSON.stringify({ data: { object: { customer_email: 'Una@Example.com' } } });
    await db
      .prepare(
        "INSERT INTO webhook_inbox(id,event_id,type,payload_json,status,received_at) VALUES('wh-done','evt_1','checkout.session.completed',?,'processed',?),('wh-dead','evt_2','checkout.session.completed',?,'dead',?),('wh-pending','evt_3','checkout.session.completed',?,'pending',?)"
      )
      .bind(event, iso(), event, iso(91 * day), event, iso())
      .run();
    const expires = Date.now() + day;
    await db
      .prepare(
        "INSERT INTO verification(id,identifier,value,expires_at) VALUES('v-reset','reset-password:abc','u1',?),('v-magic','magic-abc',?,?),('v-other','other','someone-else',?)"
      )
      .bind(expires, JSON.stringify({ email, name: '' }), expires, expires)
      .run();

    await deleteAccountAtomically(db, 'u1');

    expect(
      await count('SELECT COUNT(*) AS c FROM discount_usage WHERE customer_email=?', email)
    ).toBe(0);
    expect(
      await count('SELECT COUNT(*) AS c FROM outbox WHERE instr(payload_json, ?) > 0', email)
    ).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*) AS c FROM outbox WHERE id='ob-pending' AND (status IN ('pending','sending') OR (status='failed' AND attempts<3))"
      )
    ).toBe(0);
    const inbox = await db
      .prepare('SELECT id, payload_json FROM webhook_inbox ORDER BY id')
      .all<{ id: string; payload_json: string }>();
    expect(inbox.results).toEqual([
      { id: 'wh-dead', payload_json: event },
      { id: 'wh-done', payload_json: '{}' },
      { id: 'wh-pending', payload_json: event },
    ]);
    expect((await db.prepare('SELECT id FROM verification ORDER BY id').all()).results).toEqual([
      { id: 'v-other' },
    ]);

    await pruneRetention(db);
    expect((await db.prepare('SELECT id FROM webhook_inbox ORDER BY id').all()).results).toEqual([
      { id: 'wh-done' },
      { id: 'wh-pending' },
    ]);
  });

  it('deletes a second account whose capped code was already used by a deleted account', async () => {
    await discount('d1');
    for (const [id, email] of [
      ['u1', 'a@example.com'],
      ['u2', 'b@example.com'],
    ] as const) {
      await user(id, email);
      await order(`o-${id}`, email, id);
      await usage(`du-${id}`, 'd1', `o-${id}`, email);
      await deleteAccountAtomically(db, id);
    }
    expect(await count('SELECT COUNT(*) AS c FROM user')).toBe(0);
    expect(
      await count("SELECT COUNT(*) AS c FROM discount_usage WHERE customer_email='deleted@invalid'")
    ).toBe(2);
  });
});

describe('M3: sent outbox rows drop their payload', () => {
  it('a delivered email keeps no recipient or body', async () => {
    const stub = (await import('cloudflare:workers')) as unknown as {
      env: Record<string, unknown>;
    };
    stub.env.EMAIL = { send: async () => {} };
    const { processOutboxRow } = await import('../web/src/server/email');
    await db
      .prepare(
        "INSERT INTO outbox(id,type,payload_json,status,attempts,created_at) VALUES('ob1','email.send',?,'pending',0,?)"
      )
      .bind(JSON.stringify({ to: 'c@example.com', subject: 'Hi', text: 'hi', html: 'hi' }), iso())
      .run();
    expect(await processOutboxRow(db, 'ob1')).toBe(true);
    const row = await db.prepare("SELECT status, payload_json FROM outbox WHERE id='ob1'").first();
    expect(row).toEqual({ status: 'sent', payload_json: '{}' });
    delete stub.env.EMAIL;
  });
});

describe('L8: outbox failure log', () => {
  it('logs the outbox id and error code, never the recipient', async () => {
    const stub = (await import('cloudflare:workers')) as unknown as {
      env: Record<string, unknown>;
    };
    stub.env.EMAIL = {
      send: async () => {
        throw Object.assign(new Error('rejected for c@example.com'), { code: 'E_RATE_LIMIT' });
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { processOutboxRow } = await import('../web/src/server/email');
    await db
      .prepare(
        "INSERT INTO outbox(id,type,payload_json,status,attempts,created_at) VALUES('ob2','email.send',?,'pending',0,?)"
      )
      .bind(JSON.stringify({ to: 'c@example.com', subject: 'Hi', text: 'hi', html: 'hi' }), iso())
      .run();
    await expect(processOutboxRow(db, 'ob2')).rejects.toThrow();
    const lines = warn.mock.calls.map((call) => String(call[0]));
    const line = lines.find((l) => l.includes('outbox_delivery_failed'));
    expect(JSON.parse(line ?? '{}')).toEqual({
      event: 'outbox_delivery_failed',
      outboxId: 'ob2',
      code: 'E_RATE_LIMIT',
    });
    expect(lines.join('\n')).not.toContain('c@example.com');
    warn.mockRestore();
    delete stub.env.EMAIL;
  });
});

describe('M5: user-scoped lookups use indexes', () => {
  const plan = async (sql: string, ...values: unknown[]) =>
    (
      await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...values)
        .all<{ detail: string }>()
    ).results
      .map((r) => r.detail)
      .join(' | ');
  it.each([
    ['SELECT COUNT(*) AS n FROM orders WHERE user_id=?', 'orders_user_idx'],
    [
      'SELECT id FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20',
      'orders_user_idx',
    ],
    ['SELECT id FROM returns WHERE user_id = ?', 'returns_user_idx'],
    ['SELECT id FROM addresses WHERE user_id = ?', 'addresses_user_idx'],
    ['SELECT id FROM verification WHERE identifier = ?', 'verification_identifier_idx'],
  ])('%s', async (sql, index) => {
    const detail = await plan(sql, 'x');
    expect(detail).toContain(index);
    expect(detail).not.toContain('USE TEMP B-TREE');
  });
});

describe('M7: retention prunes auth and terminal queue rows', () => {
  it('deletes old rate_limit, expired session/verification, failed outbox and dead inbox rows only', async () => {
    await user('u1', 'una@example.com');
    const now = Date.now();
    await db
      .prepare(
        "INSERT INTO rate_limit(id,key,count,last_request) VALUES('rl-old','1.2.3.4/sign-in',1,?),('rl-new','1.2.3.5/sign-in',1,?)"
      )
      .bind(now - 2 * day, now)
      .run();
    await db
      .prepare(
        "INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('s-old','t-old','u1',?,?,?),('s-new','t-new','u1',?,?,?)"
      )
      .bind(now - 1000, now, now, now + day, now, now)
      .run();
    await db
      .prepare(
        "INSERT INTO verification(id,identifier,value,expires_at) VALUES('v-old','a','x',?),('v-new','b','x',?)"
      )
      .bind(now - 1000, now + day)
      .run();
    await db
      .prepare(
        "INSERT INTO outbox(id,type,payload_json,status,attempts,created_at) VALUES('ob-dead','email.send','{}','failed',3,?),('ob-retry','email.send','{}','failed',1,?),('ob-recent','email.send','{}','failed',3,?)"
      )
      .bind(iso(31 * day), iso(31 * day), iso(day))
      .run();
    await db
      .prepare(
        "INSERT INTO webhook_inbox(id,event_id,type,payload_json,status,received_at) VALUES('wh-dead-old','e1','t','{}','dead',?),('wh-dead-new','e2','t','{}','dead',?),('wh-pending-old','e3','t','{}','pending',?)"
      )
      .bind(iso(91 * day), iso(day), iso(91 * day))
      .run();

    await pruneRetention(db);

    const ids = async (table: string) =>
      (await db.prepare(`SELECT id FROM ${table} ORDER BY id`).all<{ id: string }>()).results.map(
        (r) => r.id
      );
    expect(await ids('rate_limit')).toEqual(['rl-new']);
    expect(await ids('session')).toEqual(['s-new']);
    expect(await ids('verification')).toEqual(['v-new']);
    expect(await ids('outbox')).toEqual(['ob-recent', 'ob-retry']);
    expect(await ids('webhook_inbox')).toEqual(['wh-dead-new', 'wh-pending-old']);
  });
});

describe('L5: discount preview without a signed-in email', () => {
  it('ignores the per-customer cap when no email is known, and enforces it when one is', async () => {
    await discount('d1');
    await order('o1', 'used@example.com', null);
    await usage('du1', 'd1', 'o1', 'used@example.com');
    expect((await calculateDiscount(db, 'D1', 5000, null))?.id).toBe('d1');
    expect(await calculateDiscount(db, 'D1', 5000, 'used@example.com')).toBeNull();
  });
});

describe('L6: customer data export', () => {
  async function seedHistory() {
    await user('u1', 'una@example.com');
    await order('o1', 'una@example.com', 'u1');
    await order('guest', 'una@example.com', null);
    await db
      .prepare(
        "INSERT INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES('oi1','o1','TEE-1','Tee',2,500)"
      )
      .run();
    await db
      .prepare(
        "INSERT INTO returns(id,order_id,user_id,reason,status,created_at) VALUES('r1','o1','u1','Too small','requested',?)"
      )
      .bind(iso())
      .run();
    await db
      .prepare(
        "INSERT INTO return_items(id,return_id,order_item_id,sku,title,qty,unit_price_cents) VALUES('ri1','r1','oi1','TEE-1','Tee',1,500)"
      )
      .run();
  }

  it('the self-service export includes items, returns and the order address, and claims nothing', async () => {
    await seedHistory();
    const { Route } = await import('../web/src/routes/api/account');
    const handler = Route.options.server!.handlers!.GET! as (ctx: {
      request: Request;
    }) => Promise<Response>;
    const response = await handler({
      request: new Request('http://localhost/api/account?export=1'),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      orders: Array<{ id: string; items: Array<{ sku: string }>; shippingAddress: unknown }>;
      returns: Array<{ id: string; items: Array<{ sku: string; qty: number }> }>;
    };
    expect(body.orders.map((o) => o.id)).toEqual(['o1']);
    expect(body.orders[0]?.items.map((i) => i.sku)).toEqual(['TEE-1']);
    expect(body.orders[0]?.shippingAddress).toEqual({ line1: '1 Main St' });
    expect(body.returns[0]?.items).toMatchObject([{ sku: 'TEE-1', qty: 1 }]);
    expect(
      (await db.prepare("SELECT user_id FROM orders WHERE id='guest'").first())?.user_id
    ).toBeNull();
  });

  it('the admin export returns the same order items and returns', async () => {
    await seedHistory();
    const { runAdminAction } = await import('../web/src/server/admin-actions');
    const result = await runAdminAction(
      db,
      {} as never,
      { id: 'owner-1', role: 'owner' },
      'customer.export',
      { userId: 'u1' }
    );
    const data = result.data as {
      orders: Array<{ items: Array<{ sku: string }> }>;
      returns: Array<{ items: Array<{ sku: string }> }>;
    };
    expect(data.orders[0]?.items.map((i) => i.sku)).toEqual(['TEE-1']);
    expect(data.returns[0]?.items.map((i) => i.sku)).toEqual(['TEE-1']);
  });
});

describe('L10 / L14: schema', () => {
  it('rate_limit has a single unique index on key', async () => {
    const rows = (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='rate_limit' AND sql IS NOT NULL"
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(rows).toEqual(['rate_limit_key_unique']);
  });

  it('the per-customer cap triggers compare customer_email directly (index usable) and still enforce', async () => {
    const triggers = (
      await db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'discount_customer_cap_%'"
        )
        .all<{ sql: string }>()
    ).results;
    expect(triggers).toHaveLength(2);
    for (const t of triggers) expect(t.sql).not.toContain('lower(customer_email)');
    await discount('d1');
    await order('o1', 'c@example.com', null);
    await order('o2', 'c@example.com', null);
    await usage('du1', 'd1', 'o1', 'c@example.com');
    await expect(usage('du2', 'd1', 'o2', 'c@example.com')).rejects.toThrow(/customer limit/);
  });
});

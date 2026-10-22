import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { createAuth } from '../web/src/lib/auth';
import { runAdminAction } from '../web/src/server/admin-actions';

let db: D1Database, dispose: () => Promise<void>;
let auth: ReturnType<typeof createAuth>;
let ownerCookie: string;
const base = 'http://localhost:8799';
async function request(path: string, body?: unknown, cookie = ownerCookie) {
  return auth.handler(
    new Request(base + '/api/auth' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
}
beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  auth = createAuth(db, base, 'round-one-secret-with-at-least-32-characters');
  await auth.api.signUpEmail({
    body: { name: 'Owner', email: 'round1@example.com', password: 'password123' },
  });
  await db
    .prepare("UPDATE user SET role='owner',email_verified=1 WHERE email='round1@example.com'")
    .run();
  const login = await request(
    '/sign-in/email',
    { email: 'round1@example.com', password: 'password123' },
    ''
  );
  expect(login.status).toBe(200);
  ownerCookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  await seedProduct(db);
});
afterAll(async () => {
  await dispose();
});

it('disables every admin-plugin HTTP endpoint, including alternate normalized paths', async () => {
  const plugin = auth.options.plugins?.find((p) => p.id === 'admin');
  expect(plugin?.endpoints).toBeTruthy();
  const paths: string[] = [];
  for (const endpoint of Object.values(plugin!.endpoints!)) {
    if (!endpoint.path) continue;
    paths.push(endpoint.path);
    const methods = [endpoint.options.method].flat();
    for (const method of methods) {
      const response = await request(
        endpoint.path,
        method === 'GET' ? undefined : { userId: 'missing', role: 'owner' }
      );
      expect(response.status, `${method} ${endpoint.path}`).toBe(404);
    }
  }
  expect(paths.length).toBeGreaterThanOrEqual(15);
  for (const path of ['/admin/set-role/', '/admin/%73et-role'])
    expect((await request(path, { userId: 'missing', role: 'owner' })).status).toBe(404);
});

it('support cannot use the raw user-list route without two-factor setup', async () => {
  await auth.api.signUpEmail({
    body: { name: 'Support', email: 'round1-support@example.com', password: 'password123' },
  });
  await db
    .prepare(
      "UPDATE user SET role='support',email_verified=1 WHERE email='round1-support@example.com'"
    )
    .run();
  const login = await request(
    '/sign-in/email',
    { email: 'round1-support@example.com', password: 'password123' },
    ''
  );
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  expect((await request('/admin/list-users', undefined, cookie)).status).toBe(404);
});

it('retains internal role updates and revokes the target sessions through the store action', async () => {
  const target = await db
    .prepare("SELECT id FROM user WHERE email='round1-support@example.com'")
    .first<{ id: string }>();
  const actor = await db
    .prepare("SELECT id FROM user WHERE email='round1@example.com'")
    .first<{ id: string }>();
  const headers = new Headers({ cookie: ownerCookie });
  const result = await runAdminAction(
    db,
    {} as never,
    { id: actor!.id, role: 'owner' },
    'user.setRole',
    { userId: target!.id, role: 'manager' },
    { auth, headers }
  );
  expect(result.ok).toBe(true);
  expect(await db.prepare('SELECT role FROM user WHERE id=?').bind(target!.id).first()).toEqual({
    role: 'manager',
  });
  expect(
    await db.prepare('SELECT COUNT(*) AS n FROM session WHERE user_id=?').bind(target!.id).first()
  ).toEqual({ n: 0 });
});

it('rejects protected self-deletion before changing orders, addresses or returns', async () => {
  const owner = await db
    .prepare("SELECT id FROM user WHERE email='round1@example.com'")
    .first<{ id: string }>();
  const timestamp = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO orders(id,number,customer_email,user_id,subtotal_cents,total_cents,created_at,updated_at) VALUES('round1-order','ROUND1','round1@example.com',?,100,100,?,?)"
      )
      .bind(owner!.id, timestamp, timestamp),
    db
      .prepare(
        "INSERT INTO addresses(id,user_id,name,line1,city,postal_code,country) VALUES('round1-address',?,'Owner','Private street','City','123','US')"
      )
      .bind(owner!.id),
    db
      .prepare(
        "INSERT INTO returns(id,order_id,user_id,reason,created_at) VALUES('round1-return','round1-order',?,'Keep me',?)"
      )
      .bind(owner!.id, timestamp),
  ]);
  const before = await db.batch([
    db.prepare("SELECT * FROM orders WHERE id='round1-order'"),
    db.prepare("SELECT * FROM addresses WHERE id='round1-address'"),
    db.prepare("SELECT * FROM returns WHERE id='round1-return'"),
  ]);
  expect((await request('/delete-user', {})).status).toBe(403);
  const after = await db.batch([
    db.prepare("SELECT * FROM orders WHERE id='round1-order'"),
    db.prepare("SELECT * FROM addresses WHERE id='round1-address'"),
    db.prepare("SELECT * FROM returns WHERE id='round1-return'"),
  ]);
  expect(after.map((r) => r.results)).toEqual(before.map((r) => r.results));
});

it('requires demotion before an owner can be administratively deleted', async () => {
  const timestamp = Date.now();
  await db
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,role,created_at,updated_at) VALUES('protected-other','Other','protected@example.com',1,'owner',?,?)"
    )
    .bind(timestamp, timestamp)
    .run();
  const result = await runAdminAction(
    db,
    {} as never,
    { id: 'another-owner', role: 'owner' },
    'customer.delete',
    { userId: 'protected-other' }
  );
  expect(result).toMatchObject({ ok: false, status: 409 });
});

it.each(['demote', 'ban', 'delete'])(
  'allows only one concurrent owner removal (%s) and protects the remaining legacy admin',
  async (operation) => {
    const t = await createTestDb();
    try {
      for (const role of ['owner', 'admin'])
        await t.db
          .prepare('INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES(?,?,?,?,0,0)')
          .bind(role, role, `${role}@race.test`, role)
          .run();
      const sql =
        operation === 'demote'
          ? "UPDATE user SET role='customer' WHERE id=?"
          : operation === 'ban'
            ? 'UPDATE user SET banned=1 WHERE id=?'
            : 'DELETE FROM user WHERE id=?';
      const results = await Promise.allSettled(
        ['owner', 'admin'].map((id) => t.db.prepare(sql).bind(id).run())
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
        operation === 'delete' ? 0 : 1
      );
      if (operation === 'delete')
        await t.db.prepare("UPDATE user SET role='customer' WHERE id='admin'").run();
      const last = await t.db
        .prepare("SELECT id FROM user WHERE role IN ('owner','admin') AND banned=0")
        .first<{ id: string }>();
      await expect(
        t.db.prepare('UPDATE user SET banned=1 WHERE id=?').bind(last!.id).run()
      ).rejects.toThrow(/owner/i);
      await expect(
        t.db.prepare('DELETE FROM user WHERE id=?').bind(last!.id).run()
      ).rejects.toThrow(/owner/i);
      await t.db
        .prepare(
          "INSERT INTO user(id,name,email,role,banned,created_at,updated_at) VALUES('banned-owner','Banned','banned@test.com','owner',1,0,0)"
        )
        .run();
      await expect(
        t.db.prepare('DELETE FROM user WHERE id=?').bind(last!.id).run()
      ).rejects.toThrow(/owner/i);
    } finally {
      await t.dispose();
    }
  }
);

it('baseline populated account data is intact and the last owner cannot be removed', async () => {
  const t = await createTestDb();
  try {
    await t.db
      .prepare(
        "INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES('upgrade-owner','Owner','upgrade@test.com','owner',0,0)"
      )
      .run();
    await seedProduct(t.db);
    await t.db.batch([
      t.db.prepare(
        "INSERT INTO orders(id,number,user_id,customer_email,subtotal_cents,total_cents,created_at,updated_at) VALUES('upgrade-order','UPGRADE','upgrade-owner','upgrade@test.com',100,100,'2026-01-01','2026-01-01')"
      ),
      t.db.prepare(
        "INSERT INTO order_items(id,order_id,sku,title,qty,unit_price_cents) VALUES('upgrade-item','upgrade-order','TEE-1','Tee',1,100)"
      ),
      t.db.prepare(
        "INSERT INTO refunds(id,request_id,order_id,amount_cents,created_at) VALUES('upgrade-refund','upgrade-refund','upgrade-order',10,'2026-01-01')"
      ),
      t.db.prepare(
        "INSERT INTO returns(id,order_id,user_id,created_at) VALUES('upgrade-return','upgrade-order','upgrade-owner','2026-01-01')"
      ),
    ]);
    const tables = ['user', 'orders', 'order_items', 'refunds', 'returns', 'stock', 'stock_ledger'];
    const before = await t.db.batch(
      tables.map((table) => t.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`))
    );
    const after = await t.db.batch(
      tables.map((table) => t.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`))
    );
    expect(after.map((r) => r.results)).toEqual(before.map((r) => r.results));
    expect((await t.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    await expect(t.db.prepare("DELETE FROM user WHERE id='upgrade-owner'").run()).rejects.toThrow(
      /must be demoted before deletion/i
    );
  } finally {
    await t.dispose();
  }
});

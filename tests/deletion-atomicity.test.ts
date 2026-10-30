import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { createAuth } from '../web/src/lib/auth';
import { runAdminAction } from '../web/src/server/admin-actions';
import { at, present } from './helpers/fixtures';

let db: D1Database, env: Env, dispose: () => Promise<void>;
let auth: ReturnType<typeof createAuth>, cookie: string, userId: string;
const base = 'http://localhost:8799';
beforeEach(async () => {
  ({ db, env, dispose } = await createTestDb());
  auth = createAuth(db, base, 'deletion-regression-secret-at-least-32-characters');
  await auth.api.signUpEmail({
    body: { name: 'Target', email: 'delete@example.invalid', password: 'password123' },
  });
  await db.prepare("UPDATE user SET email_verified=1 WHERE email='delete@example.invalid'").run();
  userId = present(
    await db
      .prepare("SELECT id FROM user WHERE email='delete@example.invalid'")
      .first<{ id: string }>(),
    'the signed-up user'
  ).id;
  const login = await auth.handler(
    new Request(base + '/api/auth/sign-in/email', {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'delete@example.invalid', password: 'password123' }),
    })
  );
  expect(login.status).toBe(200);
  cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  await db.batch([
    db.prepare(
      "INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES('actor','Actor','actor@example.invalid','owner',0,0)"
    ),
    db
      .prepare(
        "INSERT INTO orders(id,number,user_id,customer_email,shipping_name,shipping_address_json,customer_ip,subtotal_cents,total_cents,created_at,updated_at) VALUES('o','ORDER',?,'delete@example.invalid','Private','{}','192.0.2.1',100,100,'2026','2026')"
      )
      .bind(userId),
    db
      .prepare(
        "INSERT INTO addresses(id,user_id,name,line1,city,postal_code,country) VALUES('a',?,'Private','Private','City','123','US')"
      )
      .bind(userId),
    db
      .prepare(
        "INSERT INTO returns(id,order_id,user_id,reason,created_at) VALUES('r','o',?,'Defect','2026')"
      )
      .bind(userId),
    db
      .prepare(
        "INSERT INTO carts(id,token_hash,user_id,customer_email,expires_at,created_at,updated_at) VALUES('c','hash',?,'delete@example.invalid','2099','2026','2026')"
      )
      .bind(userId),
    db
      .prepare(
        "INSERT INTO posts(id,slug,title,author_id,created_at,updated_at) VALUES('p','post','Keep content',?,'2026','2026')"
      )
      .bind(userId),
    db
      .prepare(
        "INSERT INTO two_factor(id,user_id,secret,backup_codes) VALUES('factor',?,'fixture','fixture')"
      )
      .bind(userId),
    db
      .prepare(
        "INSERT INTO staff_two_factor_sessions(session_id,user_id,verified_at) SELECT id,user_id,'2026' FROM session WHERE user_id=? LIMIT 1"
      )
      .bind(userId),
  ]);
});
afterEach(async () => {
  await dispose();
});
const tables = [
  'user',
  'session',
  'account',
  'two_factor',
  'staff_two_factor_sessions',
  'orders',
  'addresses',
  'returns',
  'carts',
  'posts',
];
async function snapshot() {
  return (await db.batch(tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`)))).map(
    (r) => r.results
  );
}
async function removeSelf() {
  return auth.handler(
    new Request(base + '/api/auth/delete-user', {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: '{}',
    })
  );
}
function adminContext() {
  return {
    auth: {
      api: {
        userHasPermission: async () => ({ success: true }),
        removeUser: async () => {
          await db.prepare('DELETE FROM user WHERE id=?').bind(userId).run();
        },
      },
    } as never,
    headers: new Headers(),
  };
}
async function removed() {
  expect(await db.prepare('SELECT id FROM user WHERE id=?').bind(userId).first()).toBeNull();
  for (const t of ['session', 'account', 'two_factor', 'staff_two_factor_sessions', 'addresses'])
    expect(
      (await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id=?`).bind(userId).first())?.n
    ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT user_id,shipping_name,shipping_address_json,customer_ip FROM orders WHERE id='o'"
      )
      .first()
  ).toEqual({ user_id: null, shipping_name: null, shipping_address_json: null, customer_ip: null });
  expect(await db.prepare("SELECT user_id,reason FROM returns WHERE id='r'").first()).toEqual({
    user_id: null,
    reason: 'Defect',
  });
  expect(await db.prepare("SELECT author_id,title FROM posts WHERE id='p'").first()).toEqual({
    author_id: null,
    title: 'Keep content',
  });
  expect(await db.prepare("SELECT user_id,customer_email FROM carts WHERE id='c'").first()).toEqual(
    { user_id: null, customer_email: null }
  );
}
it('self-service deletion preserves financial/content rows, cascades credentials and clears cookies', async () => {
  const result = await removeSelf();
  expect(result.status).toBe(200);
  expect(result.headers.getSetCookie().some((c) => /Max-Age=0/.test(c))).toBe(true);
  await removed();
});
it('administrative deletion uses the atomic path without the plugin multi-write deletion', async () => {
  const result = await runAdminAction(
    db,
    env,
    { id: 'actor', role: 'owner' },
    'customer.delete',
    { userId },
    adminContext()
  );
  expect(result.ok).toBe(true);
  await removed();
});
it.each(['owner', 'admin'])(
  'rejects %s before changing any identity or associated rows',
  async (role) => {
    await db.prepare('UPDATE user SET role=? WHERE id=?').bind(role, userId).run();
    const before = await snapshot();
    expect((await removeSelf()).status).toBe(403);
    expect(
      await runAdminAction(
        db,
        env,
        { id: 'actor', role: 'owner' },
        'customer.delete',
        { userId },
        adminContext()
      )
    ).toMatchObject({ ok: false, status: 409 });
    expect(await snapshot()).toEqual(before);
    await expect(db.prepare('DELETE FROM user WHERE id=?').bind(userId).run()).rejects.toThrow(
      /owner|admin/
    );
  }
);
it('promotion between the preliminary role read and deletion rejects without anonymization', async () => {
  const before = await snapshot();
  let promoted = false;
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (stmts: D1PreparedStatement[]) => {
          if (!promoted) {
            promoted = true;
            await db.prepare("UPDATE user SET role='owner' WHERE id=?").bind(userId).run();
          }
          return db.batch(stmts);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const result = await runAdminAction(
    wrapped,
    env,
    { id: 'actor', role: 'owner' },
    'customer.delete',
    { userId },
    adminContext()
  );
  expect(result).toMatchObject({ ok: false, status: 409 });
  const after = await snapshot();
  before[0] = at(after, 0);
  expect(after).toEqual(before);
  expect((await db.prepare('SELECT role FROM user WHERE id=?').bind(userId).first())?.role).toBe(
    'owner'
  );
});
it('a final delete failure rolls back anonymization and credential removal', async () => {
  await db
    .prepare(
      "CREATE TRIGGER fail_fixture_delete BEFORE DELETE ON user WHEN OLD.email='delete@example.invalid' BEGIN SELECT RAISE(ABORT,'fixture deletion failure'); END"
    )
    .run();
  const before = await snapshot();
  expect((await removeSelf()).status).toBe(500);
  expect(await snapshot()).toEqual(before);
});
it('self-service promotion after the preliminary read leaves credentials and financial data unchanged', async () => {
  let promoted = false;
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (stmts: D1PreparedStatement[]) => {
          if (!promoted) {
            promoted = true;
            await db.prepare("UPDATE user SET role='owner' WHERE id=?").bind(userId).run();
          }
          return db.batch(stmts);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const racingAuth = createAuth(wrapped, base, 'deletion-regression-secret-at-least-32-characters');
  const before = await snapshot();
  const response = await racingAuth.handler(
    new Request(base + '/api/auth/delete-user', {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: '{}',
    })
  );
  expect(response.status).toBe(403);
  const after = await snapshot();
  before[0] = at(after, 0);
  expect(after).toEqual(before);
});
it('deletion wins before promotion and duplicate deletion cannot partially mutate rows', async () => {
  const { deleteAccountAtomically } = await import('../web/src/server/account-deletion');
  const results = await Promise.allSettled([
    deleteAccountAtomically(db, userId),
    deleteAccountAtomically(db, userId),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(
    (await db.prepare("UPDATE user SET role='owner' WHERE id=?").bind(userId).run()).meta.changes
  ).toBe(0);
  await removed();
});
it('retains Better Auth session freshness checks before invoking deletion', async () => {
  await db
    .prepare('UPDATE session SET created_at=? WHERE user_id=?')
    .bind(Date.now() - 2 * 24 * 60 * 60_000, userId)
    .run();
  const before = await snapshot();
  const result = await removeSelf();
  expect(result.status).toBe(400);
  expect(await snapshot()).toEqual(before);
});

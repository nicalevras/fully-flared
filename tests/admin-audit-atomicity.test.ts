import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';
import { createAuth } from '../web/src/lib/auth';
import { runAdminAction } from '../web/src/server/admin-actions';
import { settleRefund } from '../web/src/server/refunds';
import { fakeProvider } from './helpers/payments';
import type { PaymentProvider } from '../web/src/server/payments';
import { present } from './helpers/fixtures';

const queue = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../web/src/server/email', async (original) => ({
  ...(await original<typeof import('../web/src/server/email')>()),
  enqueueJob: queue,
}));
const refund = vi.fn(async () => ({ id: 're_audit', status: 'succeeded' }));
const findRefund = vi.fn<NonNullable<PaymentProvider['findRefundByOperation']>>(async () => null);
const provider = fakeProvider({ refund, findRefundByOperation: findRefund });
vi.mock('../web/src/server/payments', () => ({ getStripeProvider: () => provider }));

let db: D1Database, env: Env, dispose: () => Promise<void>;
let auth: ReturnType<typeof createAuth>;
let actor: { id: string; role: string };
let headers: Headers;
let sessionId: string;
beforeAll(async () => {
  ({ db, env, dispose } = await createTestDb());
  auth = createAuth(
    db,
    'http://localhost:8799',
    'atomic-audit-test-secret-with-at-least-32-characters'
  );
  await auth.api.signUpEmail({
    body: { name: 'Owner', email: 'atomic@example.com', password: 'password123' },
  });
  await db.prepare("UPDATE user SET email_verified=1 WHERE email='atomic@example.com'").run();
  const login = await auth.handler(
    new Request('http://localhost:8799/api/auth/sign-in/email', {
      method: 'POST',
      headers: { origin: 'http://localhost:8799', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'atomic@example.com', password: 'password123' }),
    })
  );
  expect(login.status).toBe(200);
  headers = new Headers({
    cookie: login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  });
  const session = present(await auth.api.getSession({ headers }), 'the signed-in customer session');
  actor = { id: session.user.id, role: 'owner' };
  sessionId = session.session.id;
  await db.batch([
    db.prepare("UPDATE user SET role='owner',two_factor_enabled=1 WHERE id=?").bind(actor.id),
    db
      .prepare(
        'INSERT INTO staff_two_factor_sessions(session_id,user_id,verified_at) VALUES(?,?,?)'
      )
      .bind(sessionId, actor.id, new Date().toISOString()),
    db.prepare(
      "INSERT INTO user(id,name,email,email_verified,role,created_at,updated_at) VALUES('backup-owner','Backup','backup@example.com',1,'owner',0,0)"
    ),
  ]);
});
afterAll(async () => {
  await dispose();
});

async function order(id: string) {
  await db
    .prepare(
      `INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,status,payment_status,stripe_payment_intent_id,created_at,updated_at)
    VALUES(?,?,'fixture@example.invalid',1000,1000,'paid','paid','pi_audit','2026','2026')`
    )
    .bind(id, id)
    .run();
}
async function requestedReturn(id: string) {
  await order(id);
  await db
    .prepare("INSERT INTO returns(id,order_id,status,created_at) VALUES(?,?,'requested','2026')")
    .bind(id, id)
    .run();
}
async function rejectAudit(action: string) {
  await db
    .prepare(
      `CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit_log WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`
    )
    .run();
}
async function restoreAudit() {
  await db.prepare('DROP TRIGGER reject_test_audit').run();
}
function run(action: string, payload: Record<string, unknown>, database = db) {
  return runAdminAction(database, env, actor, action, payload, { auth, headers, sessionId });
}

it.each(['approve', 'reject'])('rolls back return %s when its audit fails', async (decision) => {
  const id = `return-${decision}`;
  await requestedReturn(id);
  await rejectAudit(`return.${decision}`);
  try {
    expect((await run(`return.${decision}`, { returnId: id })).ok).toBe(false);
    expect(await db.prepare('SELECT status FROM returns WHERE id=?').bind(id).first()).toEqual({
      status: 'requested',
    });
  } finally {
    await restoreAudit();
  }
  expect((await run(`return.${decision}`, { returnId: id })).ok).toBe(true);
  expect((await run(`return.${decision}`, { returnId: id })).ok).toBe(false);
  expect(
    await db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE entity_id=?').bind(id).first()
  ).toEqual({ n: 1 });
});

it('rolls back shipping and its email when its audit fails', async () => {
  await order('ship-audit');
  await rejectAudit('order.ship');
  try {
    expect(
      (await run('order.ship', { orderId: 'ship-audit', trackingNumber: 'tracking' })).ok
    ).toBe(false);
    expect(await db.prepare("SELECT status FROM orders WHERE id='ship-audit'").first()).toEqual({
      status: 'paid',
    });
    expect(
      await db.prepare("SELECT id FROM outbox WHERE id='shipment-ship-audit'").first()
    ).toBeNull();
  } finally {
    await restoreAudit();
  }
});

it('rolls back an imported row if its receipt cannot be recorded', async () => {
  await rejectAudit('import.productsCsv.row');
  try {
    expect(
      await run('import.productsCsv', {
        csv: 'title,slug,sku,price_cents,stock\nAudited,audited,AUDIT-1,1000,4',
      })
    ).toMatchObject({ ok: true, data: { imported: 0, errors: [{ row: 2 }] } });
    expect(await db.prepare("SELECT id FROM products WHERE slug='audited'").first()).toBeNull();
    expect(await db.prepare("SELECT sku FROM stock WHERE sku='AUDIT-1'").first()).toBeNull();
  } finally {
    await restoreAudit();
  }
});

it('does not enqueue webhook replay without its durable requested receipt', async () => {
  await db
    .prepare(
      "INSERT INTO webhook_inbox(id,event_id,type,payload_json,status,attempts,received_at) VALUES('evt-audit','evt-audit','refund.updated','{}','dead',5,'2026')"
    )
    .run();
  queue.mockClear();
  await rejectAudit('webhook.replay.requested');
  try {
    expect((await run('webhook.replay', { eventId: 'evt-audit' })).ok).toBe(false);
    expect(queue).not.toHaveBeenCalled();
    expect(
      await db
        .prepare("SELECT status,attempts FROM webhook_inbox WHERE event_id='evt-audit'")
        .first()
    ).toEqual({ status: 'dead', attempts: 5 });
  } finally {
    await restoreAudit();
  }
  queue.mockResolvedValueOnce(false);
  expect(await run('webhook.replay', { eventId: 'evt-audit' })).toMatchObject({
    ok: false,
    status: 503,
  });
  expect(
    (
      await db
        .prepare(
          "SELECT action FROM audit_log WHERE entity_id='evt-audit' ORDER BY created_at,rowid"
        )
        .all()
    ).results
  ).toEqual([{ action: 'webhook.replay.requested' }, { action: 'webhook.replay.failed' }]);
});

it('never calls the refund provider if requested audit insertion fails', async () => {
  await order('refund-request-audit');
  refund.mockClear();
  await rejectAudit('order.refund.requested');
  try {
    expect(
      (
        await run('order.refund', {
          orderId: 'refund-request-audit',
          requestId: 'request-audit',
          amountCents: 300,
          restock: false,
        })
      ).ok
    ).toBe(false);
    expect(refund).not.toHaveBeenCalled();
    expect(
      await db.prepare("SELECT id FROM refunds WHERE request_id='request-audit'").first()
    ).toBeNull();
  } finally {
    await restoreAudit();
  }
  expect(
    (
      await run('order.refund', {
        orderId: 'refund-request-audit',
        requestId: 'request-audit',
        amountCents: 300,
        restock: false,
      })
    ).ok
  ).toBe(true);
  expect(
    (
      await run('order.refund', {
        orderId: 'refund-request-audit',
        requestId: 'request-audit',
        amountCents: 300,
        restock: false,
      })
    ).ok
  ).toBe(true);
  expect(refund).toHaveBeenCalledTimes(1);
  expect(
    await db
      .prepare(
        "SELECT actor_user_id FROM audit_log WHERE id='refund-outcome-request-audit-succeeded'"
      )
      .first()
  ).toEqual({ actor_user_id: actor.id });
});

it('keeps a queued replay recoverable if its outcome receipt fails', async () => {
  await db
    .prepare(
      "INSERT INTO webhook_inbox(id,event_id,type,payload_json,status,attempts,received_at) VALUES('evt-queued-audit','evt-queued-audit','refund.updated','{}','dead',5,'2026')"
    )
    .run();
  queue.mockClear();
  await rejectAudit('webhook.replay.queued');
  try {
    expect((await run('webhook.replay', { eventId: 'evt-queued-audit' })).ok).toBe(false);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(
      await db.prepare("SELECT status FROM webhook_inbox WHERE event_id='evt-queued-audit'").first()
    ).toEqual({ status: 'pending' });
    expect(
      await db.prepare("SELECT action FROM audit_log WHERE entity_id='evt-queued-audit'").first()
    ).toEqual({ action: 'webhook.replay.requested' });
  } finally {
    await restoreAudit();
  }
  expect(await run('webhook.replay', { eventId: 'evt-queued-audit' })).toMatchObject({
    ok: false,
    status: 409,
  });
  expect(queue).toHaveBeenCalledTimes(1);
});

it('reconciles the same provider refund after its success audit fails', async () => {
  await order('refund-retry-audit');
  const result = { id: 're_retry_audit', status: 'succeeded' };
  const input = {
    orderId: 'refund-retry-audit',
    requestId: 'retry-audit',
    amountCents: 300,
    restock: false,
  };
  refund.mockClear();
  refund.mockResolvedValueOnce(result);
  findRefund.mockResolvedValueOnce(null);
  await rejectAudit('refund.succeeded');
  try {
    expect((await run('order.refund', input)).ok).toBe(false);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith('pi_audit', 300, 'retry-audit');
    expect(await db.prepare("SELECT status FROM refunds WHERE id='retry-audit'").first()).toEqual({
      status: 'uncertain',
    });
    expect(
      await db.prepare("SELECT id FROM audit_log WHERE id='refund-requested-retry-audit'").first()
    ).toEqual({ id: 'refund-requested-retry-audit' });
  } finally {
    await restoreAudit();
  }
  await db.prepare("UPDATE refunds SET retry_after=NULL WHERE id='retry-audit'").run();
  findRefund.mockResolvedValueOnce(result);
  expect((await run('order.refund', input)).ok).toBe(true);
  expect(refund).toHaveBeenCalledTimes(1);
  expect(
    await db
      .prepare("SELECT action FROM audit_log WHERE id='refund-outcome-retry-audit-succeeded'")
      .first()
  ).toEqual({ action: 'refund.succeeded' });
});

it('rolls back refund settlement when its outcome audit fails and deduplicates recovery', async () => {
  await order('refund-outcome-audit');
  await db
    .prepare(
      "INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,status,created_at) VALUES('outcome-audit','outcome-audit','refund-outcome-audit',1000,'staff','pending','2026')"
    )
    .run();
  await rejectAudit('refund.succeeded');
  try {
    await expect(settleRefund(db, 'outcome-audit', 'succeeded', 're_outcome')).rejects.toThrow(
      'audit unavailable'
    );
    expect(await db.prepare("SELECT status FROM refunds WHERE id='outcome-audit'").first()).toEqual(
      { status: 'pending' }
    );
    expect(
      await db.prepare("SELECT payment_status FROM orders WHERE id='refund-outcome-audit'").first()
    ).toEqual({ payment_status: 'paid' });
  } finally {
    await restoreAudit();
  }
  await settleRefund(db, 'outcome-audit', 'succeeded', 're_outcome');
  await settleRefund(db, 'outcome-audit', 'succeeded', 're_outcome');
  expect(
    await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id='outcome-audit'").first()
  ).toEqual({ n: 1 });
});

it('updates roles, revokes real auth sessions, and rolls everything back if auditing fails', async () => {
  await db
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,role,created_at,updated_at) VALUES('role-target','Target','target@example.com',1,'customer',0,0)"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('target-session','target-token','role-target',?,0,0)"
    )
    .bind(Date.now() + 60000)
    .run();
  await rejectAudit('user.setRole');
  try {
    expect((await run('user.setRole', { userId: 'role-target', role: 'manager' })).ok).toBe(false);
    expect(await db.prepare("SELECT role FROM user WHERE id='role-target'").first()).toEqual({
      role: 'customer',
    });
    expect(await db.prepare("SELECT id FROM session WHERE id='target-session'").first()).toEqual({
      id: 'target-session',
    });
  } finally {
    await restoreAudit();
  }
  expect((await run('user.setRole', { userId: 'role-target', role: 'manager' })).ok).toBe(true);
  expect(await db.prepare("SELECT role FROM user WHERE id='role-target'").first()).toEqual({
    role: 'manager',
  });
  expect(await db.prepare("SELECT id FROM session WHERE id='target-session'").first()).toBeNull();
  expect((await auth.api.getSession({ headers }))?.user.role).toBe('owner');
});

it.each(['marker', 'role', 'ban', 'session'])(
  'rechecks actor %s inside the role batch',
  async (state) => {
    let injected = false;
    const raced = new Proxy(db, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!injected) {
              injected = true;
              if (state === 'marker')
                await db
                  .prepare('DELETE FROM staff_two_factor_sessions WHERE session_id=?')
                  .bind(sessionId)
                  .run();
              if (state === 'role')
                await db.prepare("UPDATE user SET role='support' WHERE id=?").bind(actor.id).run();
              if (state === 'ban')
                await db.prepare('UPDATE user SET banned=1 WHERE id=?').bind(actor.id).run();
              if (state === 'session')
                await db
                  .prepare('UPDATE session SET expires_at=0 WHERE id=?')
                  .bind(sessionId)
                  .run();
            }
            return target.batch(statements);
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect((await run('user.setRole', { userId: 'role-target', role: 'support' }, raced)).ok).toBe(
      false
    );
    expect(await db.prepare("SELECT role FROM user WHERE id='role-target'").first()).toEqual({
      role: 'manager',
    });
    await db.batch([
      db.prepare("UPDATE user SET role='owner',banned=0 WHERE id=?").bind(actor.id),
      db
        .prepare('UPDATE session SET expires_at=? WHERE id=?')
        .bind(Date.now() + 3600000, sessionId),
      db
        .prepare(
          'INSERT INTO staff_two_factor_sessions(session_id,user_id,verified_at) VALUES(?,?,?) ON CONFLICT DO NOTHING'
        )
        .bind(sessionId, actor.id, new Date().toISOString()),
    ]);
  }
);

it('keeps the last owner and their session if another owner is demoted concurrently', async () => {
  const raced = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          await db.prepare("UPDATE user SET role='customer' WHERE id='backup-owner'").run();
          return target.batch(statements);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  expect((await run('user.setRole', { userId: actor.id, role: 'customer' }, raced)).ok).toBe(false);
  expect((await auth.api.getSession({ headers }))?.user.role).toBe('owner');
  expect(await db.prepare('SELECT id FROM session WHERE id=?').bind(sessionId).first()).toEqual({
    id: sessionId,
  });
  await db.prepare("UPDATE user SET role='owner' WHERE id='backup-owner'").run();
});

it('allows self-demotion and immediately invalidates the signed-in session', async () => {
  expect(auth.options.session?.cookieCache?.enabled).toBe(false);
  expect(auth.options).not.toHaveProperty('secondaryStorage');
  expect((await auth.api.getSession({ headers }))?.user.role).toBe('owner');
  expect((await run('user.setRole', { userId: actor.id, role: 'customer' })).ok).toBe(true);
  expect(await auth.api.getSession({ headers })).toBeNull();
  expect(
    await db
      .prepare('SELECT session_id FROM staff_two_factor_sessions WHERE session_id=?')
      .bind(sessionId)
      .first()
  ).toBeNull();
});

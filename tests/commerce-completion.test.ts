import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyMigrationFile, createTestDb, seedProduct } from './helpers/d1';
import { heldOrder } from './helpers/pending-intent';
import {
  loadIntent,
  rememberProviderSession,
  reconcileCheckoutIntents,
  runIntentOperation,
} from '../web/src/server/checkout-intents';
import { deleteAccountAtomically } from '../web/src/server/account-deletion';

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 10 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await dispose();
});
async function checkout(userId?: string) {
  const id = crypto.randomUUID();
  const order = await heldOrder(
    db,
    {
      email: 'probe@example.invalid',
      userId,
      lines: [{ sku: 'TEE-1', qty: 1 }],
      shippingRateId: 'test-rate',
      shippingCountry: 'US',
    },
    {
      id,
      ownerType: userId ? 'account' : 'guest',
      userId: userId ?? null,
      guestCapabilityHash: userId ? null : 'hash',
      fingerprint: 'fp',
      sessionExpiresAt: '2999-01-01',
      payloadFor: async (_quote, orderId) => ({
        orderId,
        attemptId: id,
        email: 'probe@example.invalid',
        currency: 'USD',
        lineItems: [],
        expiresAtEpochSeconds: 32472144000,
      }),
    }
  );
  return { id, orderId: order.orderId };
}
it('a stale successful provider worker cannot attach anything to the order', async () => {
  const created = await checkout();
  const provider = {
    createCheckoutCustomer: async () => 'cus_stale',
    createCheckoutSession: async () => {
      await db
        .prepare("UPDATE checkout_intents SET claim_token='winner',fencing=fencing+1 WHERE id=?")
        .bind(created.id)
        .run();
      return { sessionId: 'cs_stale', url: 'https://stripe.test/stale' };
    },
  };
  expect(await runIntentOperation(db, provider as never, created.id)).toEqual({
    status: 'pending',
  });
  expect(
    await db
      .prepare('SELECT stripe_checkout_session_id FROM orders WHERE id=?')
      .bind(created.orderId)
      .first('stripe_checkout_session_id')
  ).toBeNull();
  expect((await loadIntent(db, created.id))?.claim_token).toBe('winner');
});
it('a failed cancellation rolls back intent retirement as well as inventory', async () => {
  const created = await checkout();
  await db
    .prepare(
      "CREATE TRIGGER reject_cancel BEFORE UPDATE OF status ON orders WHEN NEW.status='canceled' BEGIN SELECT RAISE(ABORT,'injected cancellation failure'); END"
    )
    .run();
  const provider = {
    createCheckoutSession: async () => {
      throw { statusCode: 400 };
    },
  };
  await runIntentOperation(db, provider as never, created.id).catch(() => undefined);
  expect((await loadIntent(db, created.id))?.state).not.toBe('canceled');
  expect(await db.prepare("SELECT reserved FROM stock WHERE sku='TEE-1'").first('reserved')).toBe(
    1
  );
});
it.each(['reserved', 'session_creating', 'reconciliation_required'])(
  'stops creation after the safety horizon in %s',
  async (state) => {
    const created = await checkout();
    await db
      .prepare('UPDATE checkout_intents SET state=?,created_at=?,claim_expires_at=NULL WHERE id=?')
      .bind(state, '2020-01-01', created.id)
      .run();
    const create = vi.fn(async () => ({ sessionId: 'cs_wrong', url: 'https://stripe.test/wrong' }));
    expect(
      await runIntentOperation(db, { createCheckoutSession: create } as never, created.id)
    ).toEqual({ status: 'pending' });
    expect(create).not.toHaveBeenCalled();
    expect((await loadIntent(db, created.id))?.state).toBe('reconciliation_required');
  }
);
it('expired parameters preserve provider uncertainty and still allow known-session retrieval', async () => {
  const created = await checkout();
  await db
    .prepare(
      "UPDATE checkout_intents SET state='reconciliation_required',session_expires_at='2000-01-01',stripe_session_id='cs_known' WHERE id=?"
    )
    .bind(created.id)
    .run();
  const retrieve = vi.fn(async () => ({
    id: 'cs_known',
    status: 'open',
    url: 'https://stripe.test/known',
  }));
  const create = vi.fn();
  await runIntentOperation(
    db,
    { retrieveCheckoutSession: retrieve, createCheckoutSession: create } as never,
    created.id
  );
  expect(retrieve).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
  expect(
    await db.prepare('SELECT status FROM orders WHERE id=?').bind(created.orderId).first('status')
  ).toBe('pending_payment');
});
it('deletion includes a checkout created immediately before its transaction', async () => {
  await db
    .prepare(
      "INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES('u','Probe','probe@example.invalid','customer',0,0)"
    )
    .run();
  await checkout('u');
  let injected = false;
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!injected) {
            injected = true;
            await checkout('u');
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await deleteAccountAtomically(wrapped, 'u');
  expect(
    await db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='pending_payment'").first('n')
  ).toBe(0);
  expect(await db.prepare("SELECT reserved FROM stock WHERE sku='TEE-1'").first('reserved')).toBe(
    0
  );
});

it('a failure after order attachment rolls the order write back', async () => {
  const c = await checkout();
  await db
    .prepare(
      "CREATE TRIGGER fail_ready BEFORE UPDATE OF state ON checkout_intents WHEN NEW.state='ready' BEGIN SELECT RAISE(ABORT,'injected'); END"
    )
    .run();
  const result = await runIntentOperation(
    db,
    {
      createCheckoutSession: async () => ({
        sessionId: 'cs_rollback',
        url: 'https://stripe.test/a',
      }),
    } as never,
    c.id
  );
  expect(result.status).toBe('pending');
  expect(
    await db
      .prepare('SELECT stripe_checkout_session_id FROM orders WHERE id=?')
      .bind(c.orderId)
      .first('stripe_checkout_session_id')
  ).toBeNull();
});
it('known-session retrieval failure never authorizes a creation replay or cancellation', async () => {
  const c = await checkout();
  await db
    .prepare("UPDATE checkout_intents SET stripe_session_id='cs_known' WHERE id=?")
    .bind(c.id)
    .run();
  const create = vi.fn();
  await runIntentOperation(
    db,
    {
      retrieveCheckoutSession: async () => {
        throw { statusCode: 404 };
      },
      createCheckoutSession: create,
    } as never,
    c.id
  );
  expect(create).not.toHaveBeenCalled();
  expect((await loadIntent(db, c.id))?.state).toBe('reconciliation_required');
  expect(
    await db.prepare('SELECT status FROM orders WHERE id=?').bind(c.orderId).first('status')
  ).toBe('pending_payment');
});
it('retrieval gets only the remaining orchestration budget, and no call starts after it', async () => {
  const c = await checkout();
  await db
    .prepare("UPDATE checkout_intents SET stripe_session_id='cs_known' WHERE id=?")
    .bind(c.id)
    .run();
  const retrieve = vi.fn(async (_sessionId: string, _options: { timeoutMs: number }) => null);
  await runIntentOperation(db, { retrieveCheckoutSession: retrieve } as never, c.id, {
    deadlineMs: Date.now() + 1500,
  });
  expect(retrieve).toHaveBeenCalledOnce();
  expect(retrieve.mock.calls[0]?.[1]).toEqual({ timeoutMs: expect.any(Number) });
  expect((retrieve.mock.calls[0]?.[1] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(
    1500
  );
  retrieve.mockClear();
  await runIntentOperation(db, { retrieveCheckoutSession: retrieve } as never, c.id, {
    deadlineMs: Date.now() - 1,
  });
  expect(retrieve).not.toHaveBeenCalled();
});
it('bounded provider discovery retains a matching paid session as durable inbox work', async () => {
  const c = await checkout();
  const found = {
    id: 'cs_discovered',
    payment_status: 'paid',
    amount_total: 2000,
    currency: 'usd',
    payment_intent: 'pi_discovered',
    metadata: { attempt_id: c.id, order_id: c.orderId },
  };
  await rememberProviderSession(db, found);
  await rememberProviderSession(db, found);
  expect((await loadIntent(db, c.id))?.stripe_session_id).toBe('cs_discovered');
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM webhook_inbox WHERE event_id LIKE 'reconcile-session-%'")
      .first('n')
  ).toBe(1);
});
it('a failed deletion rolls back newly selected checkout cancellation and all privacy writes', async () => {
  await db
    .prepare(
      "INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES('u','Probe','probe@example.invalid','customer',0,0)"
    )
    .run();
  const c = await checkout('u');
  await db
    .prepare(
      "CREATE TRIGGER fail_deletion BEFORE DELETE ON user BEGIN SELECT RAISE(ABORT,'injected'); END"
    )
    .run();
  await expect(deleteAccountAtomically(db, 'u')).rejects.toThrow();
  expect(
    await db.prepare('SELECT status FROM orders WHERE id=?').bind(c.orderId).first('status')
  ).toBe('pending_payment');
  expect((await loadIntent(db, c.id))?.user_id).toBe('u');
  expect(await db.prepare("SELECT reserved FROM stock WHERE sku='TEE-1'").first('reserved')).toBe(
    1
  );
});
it('a checkout loses the account-existence guard if deletion committed before its batch', async () => {
  await db
    .prepare(
      "INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES('u','Probe','probe@example.invalid','customer',0,0)"
    )
    .run();
  await deleteAccountAtomically(db, 'u');
  await expect(checkout('u')).rejects.toThrow();
  expect(await db.prepare('SELECT COUNT(*) AS n FROM orders').first('n')).toBe(0);
});
it('0009 upgrades populated 0008 without changing financial data and stops legacy uncertain creation', async () => {
  const old = await createTestDb({ through: '0008_publication_progress.sql' });
  try {
    await seedProduct(old.db);
    // Seed the historical schema directly; current writers require later columns.
    const legacy = { orderId: 'legacy-order' };
    await old.db
      .prepare(
        `INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,created_at,updated_at)
      VALUES('legacy-order','LEGACY','legacy@example.invalid',2000,2000,'2026-01-01','2026-01-01')`
      )
      .run();
    await old.db
      .prepare(
        `INSERT INTO checkout_intents(id,order_id,owner_type,fingerprint,state,provider_payload_json,coupon_idempotency_key,session_idempotency_key,session_expires_at,created_at,updated_at)
      VALUES('legacy-intent',?,'guest','fp','session_creating','{}','coupon_legacy','checkout_legacy','2999-01-01','2026-01-01','2026-01-01')`
      )
      .bind(legacy.orderId)
      .run();
    const before = await old.db.prepare('SELECT * FROM orders').all();
    await applyMigrationFile(old.db, '0009_checkout_recovery_guards.sql');
    expect((await old.db.prepare('SELECT * FROM orders').all()).results).toEqual(before.results);
    expect(
      await old.db
        .prepare("SELECT creation_stopped_at FROM checkout_intents WHERE id='legacy-intent'")
        .first('creation_stopped_at')
    ).toBeTruthy();
    expect((await old.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  } finally {
    await old.dispose();
  }
});

it('an expired claim cannot attach even when no newer worker has claimed it', async () => {
  const c = await checkout();
  await runIntentOperation(
    db,
    {
      createCheckoutSession: async () => {
        await db
          .prepare("UPDATE checkout_intents SET claim_expires_at='2000-01-01' WHERE id=?")
          .bind(c.id)
          .run();
        return { sessionId: 'cs_expired_claim', url: 'https://stripe.test/a' };
      },
    } as never,
    c.id
  );
  expect(
    await db
      .prepare('SELECT stripe_checkout_session_id FROM orders WHERE id=?')
      .bind(c.orderId)
      .first('stripe_checkout_session_id')
  ).toBeNull();
});
it('unresolved creation-stop alerts are inserted durably only once across retries', async () => {
  await db
    .prepare(
      "INSERT INTO user(id,name,email,role,email_verified,created_at,updated_at) VALUES('alert-owner','Owner','alert@example.invalid','owner',1,0,0)"
    )
    .run();
  const c = await checkout();
  await db
    .prepare("UPDATE checkout_intents SET created_at='2000-01-01' WHERE id=?")
    .bind(c.id)
    .run();
  await runIntentOperation(db, {} as never, c.id);
  const stopped = (await loadIntent(db, c.id))?.creation_stopped_at;
  await runIntentOperation(db, {} as never, c.id);
  expect((await loadIntent(db, c.id))?.creation_stopped_at).toBe(stopped);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE id LIKE 'checkout-unresolved-%'")
      .first('n')
  ).toBe(1);
});

it('deletion also scrubs a formerly guest checkout subsequently claimed by the account', async () => {
  await db
    .prepare(
      "INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES('u','Probe','probe@example.invalid','customer',0,0)"
    )
    .run();
  const c = await checkout();
  await db.prepare('UPDATE orders SET user_id=? WHERE id=?').bind('u', c.orderId).run();
  await deleteAccountAtomically(db, 'u');
  const row = await loadIntent(db, c.id);
  expect(row?.provider_payload_json).toBe('{}');
  expect(row?.guest_capability_hash).toBeNull();
});

it('recovery without an admission controller cannot contact the provider', async () => {
  await checkout();
  const create = vi.fn(async () => ({
    sessionId: 'cs_no_admission',
    url: 'https://stripe.test/a',
  }));
  await reconcileCheckoutIntents(db, { createCheckoutSession: create } as never);
  expect(create).not.toHaveBeenCalled();
});

it('a known session cannot be recreated when retrieval is unavailable', async () => {
  const c = await checkout();
  await db
    .prepare("UPDATE checkout_intents SET stripe_session_id='cs_known' WHERE id=?")
    .bind(c.id)
    .run();
  const create = vi.fn(async () => ({ sessionId: 'cs_duplicate', url: 'https://stripe.test/a' }));
  await runIntentOperation(db, { createCheckoutSession: create } as never, c.id);
  expect(create).not.toHaveBeenCalled();
  expect((await loadIntent(db, c.id))?.state).toBe('reconciliation_required');
});

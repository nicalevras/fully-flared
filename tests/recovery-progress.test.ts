import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';
import { fakeAdmissionNamespace } from './helpers/admission';
import { reconcileRefundOperations } from '../web/src/server/refunds';
import { recoverAuthorizedCheckouts } from '../web/src/server/authorized-checkout';
import type { PaymentProvider } from '../web/src/server/payments';

let db: D1Database;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await db
    .prepare(
      `INSERT INTO orders(id,number,status,payment_status,customer_email,currency,
      subtotal_cents,total_cents,stripe_payment_intent_id,created_at,updated_at)
      VALUES('progress-order','PROGRESS','paid','paid','test@example.invalid','USD',100,100,
      'pi_progress',?,?)`
    )
    .bind(new Date().toISOString(), new Date().toISOString())
    .run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await dispose();
});

function intercept(sqlMatch: RegExp, method: 'first' | 'run', replacement: () => unknown) {
  function wrap(statement: D1PreparedStatement): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === method) return replacement;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          return sqlMatch.test(sql) ? wrap(statement) : statement;
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

it('does not count a refund selected but failing before its retry claim as progress', async () => {
  await db
    .prepare(
      `INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,status,created_at)
      VALUES('progress-refund','progress-refund','progress-order',100,'staff','uncertain',?)`
    )
    .bind(new Date().toISOString())
    .run();
  const broken = intercept(
    /SELECT total_cents,stripe_payment_intent_id FROM orders/,
    'first',
    () => {
      throw new Error('Injected pre-claim lookup failure');
    }
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await reconcileRefundOperations(broken, undefined, 1)).toBe(0);
  const row = await db
    .prepare("SELECT attempts,retry_after FROM refunds WHERE id='progress-refund'")
    .first();
  expect(row).toMatchObject({ attempts: 0, retry_after: null });
  // A real retry claim durably defers the row, which is useful progress even without a provider.
  expect(await reconcileRefundOperations(db, undefined, 1)).toBe(1);
});

it('does not count an authorization selected but losing its claim as progress', async () => {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO checkout_intents(id,order_id,owner_type,guest_capability_hash,
      fingerprint,flow,provider_payload_json,coupon_idempotency_key,session_idempotency_key,
      session_expires_at,payment_next_at,created_at,updated_at)
      VALUES('progress-intent','progress-order','guest','test-hash','test-fingerprint',
      'manual_capture','{}','coupon-progress','session-progress',?,?,?,?)`
    )
    .bind(new Date(Date.now() + 3600000).toISOString(), now, now, now)
    .run();
  const blocked = intercept(
    /UPDATE checkout_intents SET payment_claim_token=/,
    'run',
    async () => ({
      meta: { changes: 0 },
    })
  );
  const retrieveCheckoutSession = vi.fn();
  const provider = { retrieveCheckoutSession } as unknown as PaymentProvider;
  expect(
    await recoverAuthorizedCheckouts(blocked, provider, fakeAdmissionNamespace().namespace, 1)
  ).toBe(0);
  expect(retrieveCheckoutSession).not.toHaveBeenCalled();
});

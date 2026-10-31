import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestDb, applyMigrationFile } from './helpers/d1';
import { fakeProvider, type ProviderCall } from './helpers/payments';
import { deleteAccountAtomically } from '../web/src/server/account-deletion';
import { processCustomerDeletion, processOutboxRow } from '../web/src/server/email';
import { pruneRetention } from '../web/src/server/operations';
import { runIntentOperation } from '../web/src/server/checkout-intents';
import {
  privacyRecoveryReport,
  reconcileCustomerOperations,
  rememberOrderCustomer,
} from '../web/src/server/stripe-customer-privacy';
import type { CheckoutRequest } from '../web/src/server/payments';
import { StripeProvider } from '../web/src/server/payments';
import { stubStripeHttp } from './helpers/stripe-http';
import { failedEmailCount } from '../web/src/server/outbox';
import { workerEnv } from '../web/src/server/env';
import { fakeQueue } from './helpers/queue';

let db: D1Database, dispose: () => Promise<void>;
const queued = vi.fn();

beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  workerEnv.NOTIFICATIONS = fakeQueue(queued);
});
afterAll(async () => {
  Reflect.deleteProperty(workerEnv, 'NOTIFICATIONS');
  await dispose();
});

async function order(id: string, userId: string | null = id) {
  const now = new Date().toISOString();
  if (userId)
    await db
      .prepare(
        "INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES(?,'Customer',?,'customer',0,0)"
      )
      .bind(userId, `${userId}@example.invalid`)
      .run();
  await db
    .prepare(
      `INSERT INTO orders(id,number,user_id,customer_email,subtotal_cents,total_cents,checkout_attempt_id,created_at,updated_at)
     VALUES(?,?,?,?,100,100,?,?,?)`
    )
    .bind(id, id, userId, `${id}@example.invalid`, `attempt-${id}`, now, now)
    .run();
}

async function intent(
  id: string,
  createdAt = new Date().toISOString(),
  customerId: string | null = null
) {
  const attemptId = `attempt-${id}`;
  const payload: CheckoutRequest = {
    orderId: id,
    attemptId,
    email: `${id}@example.invalid`,
    currency: 'USD',
    lineItems: [{ name: 'Tee', unitAmountCents: 100, qty: 1 }],
    successUrl: 'https://store.invalid/success',
    cancelUrl: 'https://store.invalid/cart',
    collectShipping: false,
    shippingCountries: ['US'],
    automaticTax: false,
    expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 3600,
  };
  await db
    .prepare(
      `INSERT INTO checkout_intents(id,order_id,owner_type,guest_capability_hash,fingerprint,provider_payload_json,
      coupon_idempotency_key,session_idempotency_key,session_expires_at,stripe_customer_id,created_at,updated_at)
     VALUES(?,?,'guest','fixture',?,?,?, ?,?,?,?,?)`
    )
    .bind(
      attemptId,
      id,
      attemptId,
      JSON.stringify(payload),
      `coupon_${attemptId}`,
      `checkout_${attemptId}`,
      new Date(Date.now() + 3600_000).toISOString(),
      customerId,
      createdAt,
      createdAt
    )
    .run();
  return attemptId;
}

const deletion = (customerId: string) =>
  db
    .prepare('SELECT status FROM outbox WHERE id=?')
    .bind(`stripe-customer-delete-${customerId}`)
    .first<{ status: string }>();

it('keeps customer associations after intent retention, including claimed guest orders', async () => {
  await order('retained');
  const attemptId = await intent('retained', '2020-01-01T00:00:00.000Z', 'cus_retained');
  await db
    .prepare("UPDATE checkout_intents SET state='canceled',payment_state='canceled' WHERE id=?")
    .bind(attemptId)
    .run();
  await pruneRetention(db);
  expect(
    await db.prepare('SELECT 1 FROM checkout_intents WHERE id=?').bind(attemptId).first()
  ).toBeNull();
  await deleteAccountAtomically(db, 'retained');
  expect(await deletion('cus_retained')).toEqual({ status: 'pending' });
});

it('records and erases a customer returned after account deletion invalidates the checkout claim', async () => {
  await order('late');
  const attemptId = await intent('late');
  const createCheckoutCustomer = vi.fn<ProviderCall<'createCheckoutCustomer'>>(async () => {
    expect(
      await db
        .prepare('SELECT 1 FROM stripe_customer_operations WHERE attempt_id=?')
        .bind(attemptId)
        .first()
    ).not.toBeNull();
    await deleteAccountAtomically(db, 'late');
    expect(await deletion('cus_late')).toBeNull();
    return 'cus_late';
  });
  const createCheckout = vi.fn<ProviderCall<'createCheckout'>>(async () => ({
    sessionId: 'unexpected',
    url: 'https://unexpected.invalid',
  }));
  expect(
    await runIntentOperation(
      db,
      fakeProvider({ createCheckoutCustomer, createCheckout }),
      attemptId
    )
  ).toEqual({ status: 'pending' });
  expect(createCheckoutCustomer).toHaveBeenCalledTimes(1);
  expect(createCheckout).not.toHaveBeenCalled();
  expect(await deletion('cus_late')).toEqual({ status: 'pending' });
  expect(
    await db
      .prepare('SELECT observed_at FROM stripe_customer_operations WHERE attempt_id=?')
      .bind(attemptId)
      .first()
  ).toEqual({ observed_at: expect.any(String) });
});

it('deduplicates late observations and protects customers with surviving associations', async () => {
  await order('shared-a');
  await order('shared-b');
  await rememberOrderCustomer(db, 'shared-a', 'attempt-shared-a', 'cus_shared');
  await rememberOrderCustomer(db, 'shared-b', 'attempt-shared-b', 'cus_shared');
  await deleteAccountAtomically(db, 'shared-a');
  expect(await deletion('cus_shared')).toBeNull();
  await deleteAccountAtomically(db, 'shared-b');
  await rememberOrderCustomer(db, 'shared-b', 'attempt-shared-b', 'cus_shared');
  const remove = vi.fn<ProviderCall<'deleteCustomer'>>(async () => {});
  await processCustomerDeletion(db, 'stripe-customer-delete-cus_shared', {
    deleteCustomer: remove,
  });
  await processCustomerDeletion(db, 'stripe-customer-delete-cus_shared', {
    deleteCustomer: remove,
  });
  expect(remove).toHaveBeenCalledTimes(1);
});

it('rechecks shared ownership at delivery and reactivates erasure when its last retained account is deleted', async () => {
  await order('claim-a');
  await rememberOrderCustomer(db, 'claim-a', 'attempt-claim-a', 'cus_claim');
  await deleteAccountAtomically(db, 'claim-a');
  await order('claim-b');
  await rememberOrderCustomer(db, 'claim-b', 'attempt-claim-b', 'cus_claim');
  const remove = vi.fn<ProviderCall<'deleteCustomer'>>(async () => {});
  await processCustomerDeletion(db, 'stripe-customer-delete-cus_claim', { deleteCustomer: remove });
  expect(remove).not.toHaveBeenCalled();
  expect(await deletion('cus_claim')).toEqual({ status: 'canceled' });
  await deleteAccountAtomically(db, 'claim-b');
  expect(await deletion('cus_claim')).toEqual({ status: 'pending' });
  await processCustomerDeletion(db, 'stripe-customer-delete-cus_claim', { deleteCustomer: remove });
  expect(remove).toHaveBeenCalledTimes(1);
});

it('scrubs and cancels unsent account mail without converting cancellation into failure', async () => {
  await order('mail');
  for (const status of ['pending', 'sending', 'failed', 'sent'])
    await db
      .prepare(
        "INSERT INTO outbox(id,type,payload_json,status,attempts,created_at) VALUES(?,'email.send',?,?,?,?)"
      )
      .bind(
        `privacy-mail-${status}`,
        JSON.stringify({
          to: 'mail@example.invalid',
          subject: 'Private',
          text: 'Private',
          html: 'Private',
        }),
        status,
        status === 'failed' ? 8 : 1,
        new Date().toISOString()
      )
      .run();
  await deleteAccountAtomically(db, 'mail');
  const rows = await db
    .prepare(
      "SELECT id,status,payload_json,attempts FROM outbox WHERE id LIKE 'privacy-mail-%' ORDER BY id"
    )
    .all();
  expect(rows.results).toEqual([
    { id: 'privacy-mail-failed', status: 'canceled', payload_json: '{}', attempts: 8 },
    { id: 'privacy-mail-pending', status: 'canceled', payload_json: '{}', attempts: 1 },
    { id: 'privacy-mail-sending', status: 'canceled', payload_json: '{}', attempts: 1 },
    { id: 'privacy-mail-sent', status: 'sent', payload_json: '{}', attempts: 1 },
  ]);
  expect(await processOutboxRow(db, 'privacy-mail-pending')).toBe(false);
  expect(await failedEmailCount(db)).toBe(0);
});

it('retains uncertain operations and reconciles every provider page after the creation deadline', async () => {
  await order('unknown');
  await db
    .prepare(
      `INSERT INTO stripe_customer_operations(attempt_id,order_id,created_at,creation_deadline_at,next_reconcile_at)
     VALUES('attempt-unknown','unknown','2020-01-01T00:00:00.000Z','2020-01-01T23:00:00.000Z','2020-01-01T00:00:00.000Z')`
    )
    .run();
  await deleteAccountAtomically(db, 'unknown');
  await pruneRetention(db);
  const listCustomersPage = vi
    .fn<ProviderCall<'listCustomersPage'>>()
    .mockResolvedValueOnce({ data: [{ id: 'cus_unrelated', metadata: {} }], hasMore: true })
    .mockResolvedValueOnce({
      data: [
        { id: 'cus_unknown', metadata: { order_id: 'unknown', attempt_id: 'attempt-unknown' } },
      ],
      hasMore: false,
    });
  expect(await reconcileCustomerOperations(db, { listCustomersPage })).toEqual({
    checked: 1,
    more: true,
  });
  expect(await reconcileCustomerOperations(db, { listCustomersPage })).toEqual({
    checked: 1,
    more: false,
  });
  expect(listCustomersPage).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ startingAfter: 'cus_unrelated', limit: 100 }),
    { timeoutMs: 10_000 }
  );
  expect(await deletion('cus_unknown')).toEqual({ status: 'pending' });
});

it('does not treat an empty provider scan as proof that an uncertain customer never existed', async () => {
  await order('empty-scan');
  await db
    .prepare(
      `INSERT INTO stripe_customer_operations(attempt_id,order_id,created_at,creation_deadline_at,next_reconcile_at)
     VALUES('attempt-empty-scan','empty-scan','2020-01-01T00:00:00.000Z','2020-01-01T23:00:00.000Z','2020-01-01T00:00:00.000Z')`
    )
    .run();
  await reconcileCustomerOperations(db, {
    listCustomersPage: async () => ({ data: [], hasMore: false }),
  });
  expect(
    await db
      .prepare(
        "SELECT observed_at FROM stripe_customer_operations WHERE attempt_id='attempt-empty-scan'"
      )
      .first()
  ).toEqual({ observed_at: null });
  expect((await privacyRecoveryReport(db)).unresolvedCustomerOperations).toBeGreaterThan(0);
  expect((await privacyRecoveryReport(db)).historicalProviderReconciliationRequired).toBe(true);
});

it('finds a timed-out customer created after the creation-call deadline', async () => {
  await order('late-created');
  await db
    .prepare(
      `INSERT INTO stripe_customer_operations
    (attempt_id,order_id,created_at,creation_deadline_at,next_reconcile_at)
    VALUES('attempt-late-created','late-created','2020-01-01T00:00:00.000Z',
      '2020-01-01T23:00:00.000Z','2020-01-01T00:00:00.000Z')`
    )
    .run();
  await deleteAccountAtomically(db, 'late-created');
  const customerCreated = Date.parse('2020-01-01T23:02:00.000Z') / 1000;
  const listCustomersPage = vi.fn<ProviderCall<'listCustomersPage'>>(async (input) => ({
    data:
      input.createdBefore < customerCreated
        ? []
        : [
            {
              id: 'cus_late_created',
              metadata: { order_id: 'late-created', attempt_id: 'attempt-late-created' },
            },
          ],
    hasMore: false,
  }));
  await reconcileCustomerOperations(db, { listCustomersPage }, '2020-01-02T00:00:00.000Z');
  expect(listCustomersPage).toHaveBeenCalledTimes(1);
  expect(await deletion('cus_late_created')).toEqual({ status: 'pending' });
});

it('recovers an uncertain creation after its intent was pruned and its account deleted', async () => {
  await order('lost-response');
  const attemptId = await intent('lost-response');
  const createCheckoutCustomer = vi.fn<ProviderCall<'createCheckoutCustomer'>>(async () => {
    throw new Error('Provider response lost after creation');
  });
  expect(await runIntentOperation(db, fakeProvider({ createCheckoutCustomer }), attemptId)).toEqual(
    { status: 'pending' }
  );
  expect(createCheckoutCustomer).toHaveBeenCalledTimes(1);
  await db
    .prepare(
      "UPDATE checkout_intents SET state='canceled',payment_state='canceled',created_at='2020-01-01T00:00:00.000Z' WHERE id=?"
    )
    .bind(attemptId)
    .run();
  await pruneRetention(db);
  await deleteAccountAtomically(db, 'lost-response');
  await reconcileCustomerOperations(db, {
    listCustomersPage: async () => ({
      data: [
        { id: 'cus_lost_response', metadata: { order_id: 'lost-response', attempt_id: attemptId } },
      ],
      hasMore: false,
    }),
  });
  expect(await deletion('cus_lost_response')).toEqual({ status: 'pending' });
});

it('never restarts customer creation after the idempotency safety deadline', async () => {
  await order('expired-creation');
  const attemptId = await intent('expired-creation', '2020-01-01T00:00:00.000Z');
  const createCheckoutCustomer = vi.fn<ProviderCall<'createCheckoutCustomer'>>(
    async () => 'cus_forbidden'
  );
  expect(await runIntentOperation(db, fakeProvider({ createCheckoutCustomer }), attemptId)).toEqual(
    { status: 'pending' }
  );
  expect(createCheckoutCustomer).not.toHaveBeenCalled();
  expect(await deletion('cus_forbidden')).toBeNull();
});

it('keeps exhausted erasure jobs for operator recovery while pruning canceled notifications', async () => {
  await db
    .prepare(
      "INSERT INTO outbox(id,type,payload_json,status,attempts,created_at) VALUES('erasure-retained','stripe.customer.delete','{}','failed',8,'2020-01-01T00:00:00.000Z')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO outbox(id,type,payload_json,status,created_at) VALUES('cancellation-pruned','email.send','{}','canceled','2020-01-01T00:00:00.000Z')"
    )
    .run();
  await pruneRetention(db);
  expect(
    await db.prepare("SELECT 1 FROM outbox WHERE id='erasure-retained'").first()
  ).not.toBeNull();
  expect(
    await db.prepare("SELECT 1 FROM outbox WHERE id='cancellation-pruned'").first()
  ).toBeNull();
});

it('backfills retained customers and uncertain attempts without claiming already-pruned history was recovered', async () => {
  const historical = await createTestDb({ through: '0038_variants_version.sql' });
  try {
    await historical.db
      .prepare(
        "INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES('legacy','Legacy','legacy@example.invalid','customer',0,0)"
      )
      .run();
    for (const id of ['known', 'uncertain', 'pruned']) {
      await historical.db
        .prepare(
          `INSERT INTO orders(id,number,user_id,customer_email,subtotal_cents,total_cents,checkout_attempt_id,created_at,updated_at)
         VALUES(?,?,'legacy','legacy@example.invalid',100,100,?,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')`
        )
        .bind(id, id, `attempt-${id}`)
        .run();
      if (id !== 'pruned')
        await historical.db
          .prepare(
            `INSERT INTO checkout_intents(id,order_id,owner_type,user_id,fingerprint,provider_payload_json,
          coupon_idempotency_key,session_idempotency_key,session_expires_at,stripe_customer_id,provider_step,first_provider_attempt_at,created_at,updated_at)
         VALUES(?,?,'account','legacy',?,'{}',?,?,'2020-01-01T01:00:00.000Z',?,'customer','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')`
          )
          .bind(
            `attempt-${id}`,
            id,
            id,
            `coupon-${id}`,
            `checkout-${id}`,
            id === 'known' ? 'cus_legacy' : null
          )
          .run();
    }
    await historical.db
      .prepare(
        `INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,checkout_attempt_id,created_at,updated_at)
       VALUES('erased','erased','deleted@invalid',100,100,'attempt-erased','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')`
      )
      .run();
    await historical.db
      .prepare(
        `INSERT INTO checkout_intents(id,order_id,owner_type,guest_capability_hash,fingerprint,provider_payload_json,
       coupon_idempotency_key,session_idempotency_key,session_expires_at,stripe_customer_id,created_at,updated_at)
       VALUES('attempt-erased','erased','guest','fixture','erased','{}','coupon-erased','checkout-erased','2020-01-01T01:00:00.000Z','cus_erased','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')`
      )
      .run();
    await applyMigrationFile(historical.db, '0039_stripe_customer_privacy.sql');
    await applyMigrationFile(historical.db, '0040_outbox_cancellation.sql');
    await applyMigrationFile(historical.db, '0041_export_keyset_indexes.sql');
    await applyMigrationFile(historical.db, '0042_privacy_gap_index.sql');
    expect(
      (
        await historical.db
          .prepare('SELECT customer_id FROM order_stripe_customers ORDER BY customer_id')
          .all()
      ).results
    ).toEqual([{ customer_id: 'cus_erased' }, { customer_id: 'cus_legacy' }]);
    expect(
      await historical.db
        .prepare("SELECT status FROM outbox WHERE id='stripe-customer-delete-cus_erased'")
        .first()
    ).toEqual({ status: 'pending' });
    expect(await privacyRecoveryReport(historical.db)).toEqual({
      historicalOrdersWithoutCustomerAssociation: 1,
      unresolvedCustomerOperations: 1,
      ambiguousScrubbedEmails: 0,
      historicalProviderReconciliationRequired: true,
    });
    await deleteAccountAtomically(historical.db, 'legacy');
    expect(
      await historical.db
        .prepare("SELECT status FROM outbox WHERE id='stripe-customer-delete-cus_legacy'")
        .first()
    ).toEqual({ status: 'pending' });
  } finally {
    await historical.dispose();
  }
});

it('uses bounded Stripe list pagination rather than eventually consistent customer search', async () => {
  const requests = stubStripeHttp(() =>
    Response.json({
      object: 'list',
      url: '/v1/customers',
      data: [{ id: 'cus_page', metadata: { order_id: 'order-page', attempt_id: 'attempt-page' } }],
      has_more: true,
    })
  );
  try {
    const provider = new StripeProvider('sk_test_fixture', 'whsec_fixture');
    expect(
      await provider.listCustomersPage(
        { limit: 100, createdAfter: 100, createdBefore: 200, startingAfter: 'cus_previous' },
        { timeoutMs: 1000 }
      )
    ).toEqual({
      data: [{ id: 'cus_page', metadata: { order_id: 'order-page', attempt_id: 'attempt-page' } }],
      hasMore: true,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe('/v1/customers');
    expect(requests[0]?.url.searchParams.get('created[gte]')).toBe('100');
    expect(requests[0]?.url.searchParams.get('created[lte]')).toBe('200');
    expect(requests[0]?.url.searchParams.get('starting_after')).toBe('cus_previous');
  } finally {
    vi.unstubAllGlobals();
  }
});

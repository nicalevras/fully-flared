import Stripe from '../web/node_modules/stripe/esm/stripe.esm.node.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { heldOrder } from './helpers/pending-intent';
import { deleteAccountAtomically } from '../web/src/server/account-deletion';
import { MAX_EMAIL_ATTEMPTS } from '../web/src/server/outbox';
import { workerEnv } from '../web/src/server/env';
import * as payments from '../web/src/server/payments';

let db: D1Database, dispose: () => Promise<void>;
const names = { JOBS: 'money', NOTIFICATIONS: 'mail', CATALOG_JOBS: 'catalog', DLQ: 'dead' };
const mail = vi.fn();
const provider = { deleteCustomer: vi.fn(async (_id: string) => {}) };

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  mail.mockReset();
  provider.deleteCustomer.mockReset();
  provider.deleteCustomer.mockResolvedValue(undefined);
  workerEnv.NOTIFICATIONS = { send: mail };
  vi.spyOn(payments, 'getStripeProvider').mockReturnValue(provider);
  await seedProduct(db, { onHand: 10, priceCents: 2000 });
  await db
    .prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES('operational_alert_email','ops@example.invalid','2026-01-01T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    .run();
  for (const id of ['cust', 'other'])
    await db
      .prepare(
        "INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES(?,'Cust',?,'customer',0,0)"
      )
      .bind(id, `${id}@example.invalid`)
      .run();
  for (const [userId, customerId] of [
    ['cust', 'cus_a'],
    ['cust', 'cus_b'],
    ['cust', 'cus_a'],
    ['other', 'cus_other'],
  ]) {
    const created = await heldOrder(
      db,
      {
        email: `${userId}@example.invalid`,
        userId,
        lines: [{ sku: 'TEE-1', qty: 1 }],
        shippingRateId: 'test-rate',
        shippingCountry: 'US',
      },
      { ownerType: 'account', userId, guestCapabilityHash: null }
    );
    await db
      .prepare('UPDATE checkout_intents SET stripe_customer_id=? WHERE order_id=?')
      .bind(customerId, created.orderId)
      .run();
  }
});
afterEach(async () => {
  delete workerEnv.NOTIFICATIONS;
  vi.restoreAllMocks();
  await dispose();
});

async function deliver(bodies: unknown[]) {
  const { default: worker } = await import('../web/src/server');
  const ack = vi.fn(),
    retry = vi.fn();
  await worker.queue(
    { queue: 'mail', messages: bodies.map((body) => ({ body, ack, retry })) },
    { DB: db, QUEUE_NAMES: names, NOTIFICATIONS: { send: mail } },
    {}
  );
  return { ack, retry };
}

const deleteJob = (customerId: string) => ({
  type: 'stripe.customer.delete',
  outboxId: `stripe-customer-delete-${customerId}`,
});

async function outboxRow(id: string) {
  return db
    .prepare('SELECT type, status, attempts FROM outbox WHERE id=?')
    .bind(id)
    .first<{ type: string; status: string; attempts: number }>();
}

it('deletion queues customers.del for each id', async () => {
  await deleteAccountAtomically(db, 'cust');

  const queued = mail.mock.calls.map(([body]) => body);
  expect(queued).toHaveLength(2);
  expect(queued).toEqual(expect.arrayContaining([deleteJob('cus_a'), deleteJob('cus_b')]));

  await deliver(queued);
  await deliver(queued);
  expect(provider.deleteCustomer.mock.calls.map(([id]) => id).sort()).toEqual(['cus_a', 'cus_b']);
  expect(await outboxRow('stripe-customer-delete-cus_a')).toEqual({
    type: 'stripe.customer.delete',
    status: 'sent',
    attempts: 0,
  });
  expect(await outboxRow('stripe-customer-delete-cus_other')).toBeNull();
});

it('an email job never runs a customer deletion row', async () => {
  await deleteAccountAtomically(db, 'cust');

  const { ack } = await deliver([{ type: 'email.send', outboxId: 'stripe-customer-delete-cus_a' }]);
  expect(ack).toHaveBeenCalledTimes(1);
  expect(provider.deleteCustomer).not.toHaveBeenCalled();
  expect((await outboxRow('stripe-customer-delete-cus_a'))?.status).toBe('pending');
});

it('a failing delete backs off, then alerts the operator once attempts run out', async () => {
  await deleteAccountAtomically(db, 'cust');
  provider.deleteCustomer.mockRejectedValue(new Error('Stripe unavailable'));

  const first = await deliver([deleteJob('cus_a')]);
  expect(first.retry).toHaveBeenCalledTimes(1);
  expect(await outboxRow('stripe-customer-delete-cus_a')).toEqual({
    type: 'stripe.customer.delete',
    status: 'failed',
    attempts: 1,
  });

  await db
    .prepare('UPDATE outbox SET attempts=?, retry_after=NULL WHERE id=?')
    .bind(MAX_EMAIL_ATTEMPTS - 1, 'stripe-customer-delete-cus_a')
    .run();
  await deliver([deleteJob('cus_a')]);
  const alert = await db
    .prepare(
      "SELECT payload_json FROM outbox WHERE id LIKE 'outbox-alert-stripe-customer-delete-cus_a%'"
    )
    .first<{ payload_json: string }>();
  expect(JSON.parse(alert?.payload_json ?? '{}')).toEqual(
    expect.objectContaining({
      to: 'ops@example.invalid',
      subject: 'Stripe customer deletion failed permanently',
    })
  );
});

it('a customer Stripe no longer has counts as deleted', async () => {
  const stripeProvider = new payments.StripeProvider('sk_test_fixture', 'whsec_fixture');
  const stripe = Reflect.get(stripeProvider, 'stripe');
  const del = vi.spyOn(stripe.customers, 'del');
  del.mockRejectedValueOnce(
    new Stripe.errors.StripeInvalidRequestError({
      message: 'No such customer',
      statusCode: 404,
      code: 'resource_missing',
    })
  );
  await expect(stripeProvider.deleteCustomer('cus_gone')).resolves.toBeUndefined();
  del.mockRejectedValueOnce(new Error('provider outage'));
  await expect(stripeProvider.deleteCustomer('cus_x')).rejects.toThrow('provider outage');
});

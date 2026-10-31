import Stripe from '../web/node_modules/stripe/esm/stripe.esm.node.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { heldOrder } from './helpers/pending-intent';
import { deleteAccountAtomically } from '../web/src/server/account-deletion';
import { MAX_EMAIL_ATTEMPTS } from '../web/src/server/outbox';
import { workerEnv } from '../web/src/server/env';
import * as payments from '../web/src/server/payments';
import { fakeProvider, type ProviderCall } from './helpers/payments';
import { fakeQueue, messageBatch, queueMessage } from './helpers/queue';
import { gatewayContext } from './helpers/gateway';
import { stubStripeHttp } from './helpers/stripe-http';

let db: D1Database, bindings: Cloudflare.Env, dispose: () => Promise<void>;
const mail = vi.fn();
const notifications = fakeQueue(mail);
const deleteCustomer = vi.fn<ProviderCall<'deleteCustomer'>>(async () => {});
const customerOrders: [userId: string, customerId: string][] = [
  ['cust', 'cus_a'],
  ['cust', 'cus_b'],
  ['cust', 'cus_a'],
  ['other', 'cus_other'],
];

beforeEach(async () => {
  ({ db, env: bindings, dispose } = await createTestDb());
  mail.mockReset();
  deleteCustomer.mockReset();
  deleteCustomer.mockResolvedValue(undefined);
  workerEnv.NOTIFICATIONS = notifications;
  vi.spyOn(payments, 'getStripeProvider').mockReturnValue(fakeProvider({ deleteCustomer }));
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
  for (const [userId, customerId] of customerOrders) {
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
  Reflect.deleteProperty(workerEnv, 'NOTIFICATIONS');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await dispose();
});

async function deliver(bodies: unknown[]) {
  const { default: worker } = await import('../web/src/server');
  const ack = vi.fn(),
    retry = vi.fn();
  await worker.queue(
    messageBatch(
      bindings.QUEUE_NAMES.NOTIFICATIONS,
      bodies.map((body) => queueMessage(body, { ack, retry }))
    ),
    {
      ...bindings,
      DB: db,
      JOBS: fakeQueue(),
      NOTIFICATIONS: notifications,
      CATALOG_JOBS: fakeQueue(),
    },
    gatewayContext()
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
  expect(deleteCustomer.mock.calls.map(([id]) => id).sort()).toEqual(['cus_a', 'cus_b']);
  expect(await outboxRow('stripe-customer-delete-cus_a')).toEqual({
    type: 'stripe.customer.delete',
    status: 'sent',
    attempts: 1,
  });
  expect(await outboxRow('stripe-customer-delete-cus_other')).toBeNull();
});

it('an email job never runs a customer deletion row', async () => {
  await deleteAccountAtomically(db, 'cust');

  const { ack } = await deliver([{ type: 'email.send', outboxId: 'stripe-customer-delete-cus_a' }]);
  expect(ack).toHaveBeenCalledTimes(1);
  expect(deleteCustomer).not.toHaveBeenCalled();
  expect((await outboxRow('stripe-customer-delete-cus_a'))?.status).toBe('pending');
});

it('a failing delete backs off, then alerts the operator once attempts run out', async () => {
  await deleteAccountAtomically(db, 'cust');
  deleteCustomer.mockRejectedValue(new Error('Stripe unavailable'));

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
  const requests = stubStripeHttp(({ url }) => {
    if (url.pathname === '/v1/customers/cus_x') throw new TypeError('provider outage');
    return Response.json(
      {
        error: {
          type: 'invalid_request_error',
          code: 'resource_missing',
          message: 'No such customer',
        },
      },
      { status: 404 }
    );
  });
  await expect(stripeProvider.deleteCustomer('cus_gone')).resolves.toBeUndefined();
  await expect(stripeProvider.deleteCustomer('cus_x')).rejects.toBeInstanceOf(
    Stripe.errors.StripeConnectionError
  );
  expect(requests.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual([
    'DELETE /v1/customers/cus_gone',
    'DELETE /v1/customers/cus_x',
  ]);
});

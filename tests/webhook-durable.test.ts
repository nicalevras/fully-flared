import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';
import { env } from './helpers/cloudflare-workers-stub';
import { Route } from '../web/src/routes/api/webhooks/stripe';
import { reprocessStaleInbox } from '../web/src/server/checkout';
import { WebhookSignatureError, type PaymentProvider } from '../web/src/server/payments';
import { deliverStripeEvent } from './helpers/webhook';

// Phase 6 durable webhook delivery. Replaces webhook-inline.test.ts:
// the queue-unavailable inline fallback is gone by design — the inbox
// row is the durable record and cron recovery owns processing.
const provider = vi.hoisted(() => ({
  verifyWebhook: vi.fn(async (payload: string) => JSON.parse(payload)),
  retrieveRefund: vi.fn(async (id: string) => ({ id, status: 'succeeded' })),
}));
vi.mock('../web/src/server/payments', async (original) => ({
  ...(await original<typeof import('../web/src/server/payments')>()),
  getStripeProvider: () => provider,
}));
vi.mock('../web/src/server/email', async (original) => ({
  ...(await original<typeof import('../web/src/server/email')>()),
  enqueueJob: async () => false,
}));

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  env.DB = db;
  provider.retrieveRefund.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete env.DB;
  await dispose();
});

it('queue failure defers to durable recovery: acked, not processed inline, completed exactly once by the sweep', async () => {
  await db
    .prepare(
      "INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,status,payment_status,stripe_payment_intent_id,created_at,updated_at) VALUES('o','o','fixture@example.invalid',1000,1000,'paid','paid','pi_1','2026','2026')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO refunds(id,request_id,order_id,stripe_refund_id,amount_cents,purpose,status,created_at) VALUES('rf','rf','o','re_1',100,'staff','pending','2026')"
    )
    .run();
  const payload = JSON.stringify({
    id: 'evt_durable_refund',
    type: 'refund.updated',
    data: {
      object: { id: 're_1', payment_intent: 'pi_1', amount: 100, status: 'pending' },
    },
  });
  const handler = Route.options.server!.handlers!.POST!;
  const post = () =>
    (handler as (ctx: { request: Request }) => Promise<Response>)({
      request: new Request('http://localhost/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': 'sig_fixture' },
        body: payload,
      }),
    });

  const response = await post();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, queued: false });
  // No inline financial work happened in the request path.
  expect(provider.retrieveRefund).not.toHaveBeenCalled();
  expect((await db.prepare("SELECT status FROM refunds WHERE id='rf'").first())?.status).toBe(
    'pending'
  );
  const inboxStatus = async () =>
    (
      await db
        .prepare("SELECT status FROM webhook_inbox WHERE event_id='evt_durable_refund'")
        .first<{ status: string }>()
    )?.status;
  expect(await inboxStatus()).toBe('pending');

  // A Stripe redelivery is duplicate-acked without reprocessing.
  const duplicate = await post();
  expect(await duplicate.json()).toMatchObject({ ok: true, duplicate: true });
  expect(provider.retrieveRefund).not.toHaveBeenCalled();

  // Cron recovery (the stale-inbox sweep) completes it exactly once.
  await db
    .prepare(
      "UPDATE webhook_inbox SET received_at = '2020-01-01T00:00:00.000Z' WHERE event_id='evt_durable_refund'"
    )
    .run();
  expect(await reprocessStaleInbox(db, provider as never, 10)).toBe(1);
  expect(provider.retrieveRefund).toHaveBeenCalledWith('re_1');
  expect((await db.prepare("SELECT status FROM refunds WHERE id='rf'").first())?.status).toBe(
    'succeeded'
  );
  expect(await inboxStatus()).toBe('processed');
  // A second sweep has nothing left to do.
  expect(await reprocessStaleInbox(db, provider as never, 10)).toBe(0);
});

function postWebhook(body: string) {
  const handler = Route.options.server!.handlers!.POST!;
  return (handler as (ctx: { request: Request }) => Promise<Response>)({
    request: new Request('http://localhost/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_fixture' },
      body,
    }),
  });
}

it('a bad signature is a 400; a failed inbox write is a 500 so Stripe retries', async () => {
  const body = JSON.stringify({ id: 'evt_inbox', type: 'refund.updated', data: { object: {} } });
  provider.verifyWebhook.mockRejectedValueOnce(new WebhookSignatureError());
  expect((await postWebhook(body)).status).toBe(400);
  await db.prepare('DROP TABLE webhook_inbox').run();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await postWebhook(body)).status).toBe(500);
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('stripe_webhook_inbox_failed')
  );
});

const disputeProvider: PaymentProvider = {
  createCheckout: vi.fn(),
  refund: vi.fn(),
  verifyWebhook: async (payload) => JSON.parse(payload),
};
async function deliverDispute(id: string, type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id, type, data: { object } });
  return deliverStripeEvent(db, disputeProvider, payload, 'sig_fixture').catch(() => false);
}
async function inboxRow(id: string) {
  return db.prepare('SELECT status FROM webhook_inbox WHERE event_id=?').bind(id).first();
}
async function disputedOrder() {
  await db
    .prepare(
      "INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,status,payment_status,stripe_payment_intent_id,created_at,updated_at) VALUES('od','od','fixture@example.invalid',1000,1000,'paid','disputed','pi_d','2026','2026')"
    )
    .run();
}

it('a dispute closed as prevented clears the dispute', async () => {
  await disputedOrder();
  await deliverDispute('evt_prevented', 'charge.dispute.closed', {
    id: 'dp_prevented',
    payment_intent: 'pi_d',
    status: 'prevented',
  });
  expect(await inboxRow('evt_prevented')).toMatchObject({ status: 'processed' });
  expect(await db.prepare("SELECT payment_status FROM orders WHERE id='od'").first()).toMatchObject(
    { payment_status: 'paid' }
  );
});

it('a dispute without a PaymentIntent is logged and skipped without emailing anyone', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await deliverDispute('evt_unmatched_open', 'charge.dispute.created', {
    id: 'dp_unmatched',
    payment_intent: null,
  });
  await deliverDispute('evt_unmatched_closed', 'charge.dispute.closed', {
    id: 'dp_unmatched',
    payment_intent: null,
    status: 'lost',
  });
  expect(await inboxRow('evt_unmatched_open')).toMatchObject({ status: 'processed' });
  expect(await inboxRow('evt_unmatched_closed')).toMatchObject({ status: 'processed' });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('webhook_dispute_unmatched'));
  expect((await db.prepare('SELECT COUNT(*) n FROM outbox').first())?.n).toBe(0);
});

it('a dispute closed with an unknown status is retried, never silently processed', async () => {
  await disputedOrder();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await deliverDispute('evt_unknown', 'charge.dispute.closed', {
    id: 'dp_unknown',
    payment_intent: 'pi_d',
    status: 'under_review',
  });
  expect(await inboxRow('evt_unknown')).toMatchObject({ status: 'failed' });
  expect(await db.prepare("SELECT payment_status FROM orders WHERE id='od'").first()).toMatchObject(
    { payment_status: 'disputed' }
  );
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';
import { env } from './helpers/cloudflare-workers-stub';
import { Route } from '../web/src/routes/api/webhooks/stripe';
import { reprocessStaleInbox } from '../web/src/server/checkout';

// Phase 6 durable webhook delivery. Replaces webhook-inline.test.ts:
// the queue-unavailable inline fallback is gone by design — the inbox
// row is the durable record and cron recovery owns processing.
const provider = vi.hoisted(() => ({
  verifyWebhook: vi.fn(async (payload: string) => JSON.parse(payload)),
  retrieveRefund: vi.fn(async (id: string) => ({ id, status: 'succeeded' })),
}));
vi.mock('../web/src/server/payments', () => ({ getStripeProvider: () => provider }));
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

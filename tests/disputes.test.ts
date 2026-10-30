import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';
import { deliverStripeEvent } from './helpers/webhook';
import { processInboxEvent } from '../web/src/server/checkout';
import type { PaymentProvider } from '../web/src/server/payments';

let db: D1Database, dispose: () => Promise<void>;
const sessionFor = vi.fn(async (_pi: string): Promise<string | null> => null);
const offline: PaymentProvider = {
  createCheckout: vi.fn(),
  refund: vi.fn(),
  verifyWebhook: async (payload) => JSON.parse(payload),
};
const provider: PaymentProvider = { ...offline, findCheckoutSessionIdByPaymentIntent: sessionFor };

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  sessionFor.mockReset();
  sessionFor.mockResolvedValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await db
    .prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES('operational_alert_email','ops@example.invalid','2026-01-01T00:00:00.000Z')"
    )
    .run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await dispose();
});

const disputeCreated = (eventId: string, pi: string) =>
  JSON.stringify({
    id: eventId,
    type: 'charge.dispute.created',
    data: { object: { id: `dp_${eventId}`, payment_intent: pi } },
  });

async function inboxRow(eventId: string) {
  return db
    .prepare('SELECT status, attempts FROM webhook_inbox WHERE event_id=?')
    .bind(eventId)
    .first<{ status: string; attempts: number }>();
}

async function retryNow(eventId: string, withProvider: PaymentProvider | undefined) {
  await db
    .prepare('UPDATE webhook_inbox SET retry_after=NULL WHERE event_id=?')
    .bind(eventId)
    .run();
  return processInboxEvent(db, eventId, withProvider).catch(() => false);
}

it('foreign dispute is processed once, not dead-lettered', async () => {
  await deliverStripeEvent(db, provider, disputeCreated('evt_foreign', 'pi_foreign'), 'sig').catch(
    () => false
  );
  await deliverStripeEvent(db, provider, disputeCreated('evt_foreign', 'pi_foreign'), 'sig').catch(
    () => false
  );

  expect(await inboxRow('evt_foreign')).toEqual({ status: 'processed', attempts: 0 });
  expect(sessionFor).toHaveBeenCalledTimes(1);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('webhook_dispute_unmatched'));
  expect((await db.prepare('SELECT COUNT(*) n FROM outbox').first())?.n).toBe(0);
});

it('early dispute for our session is processed once the order maps', async () => {
  sessionFor.mockResolvedValue('cs_ours');
  await deliverStripeEvent(db, provider, disputeCreated('evt_early', 'pi_ours'), 'sig').catch(
    () => false
  );
  expect(await inboxRow('evt_early')).toEqual({ status: 'failed', attempts: 1 });

  await db
    .prepare(
      "INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,status,payment_status,stripe_checkout_session_id,created_at,updated_at) VALUES('o1','o1','fixture@example.invalid',1000,1000,'paid','paid','cs_ours','2026','2026')"
    )
    .run();
  await retryNow('evt_early', provider);

  expect((await inboxRow('evt_early'))?.status).toBe('processed');
  expect(
    await db
      .prepare("SELECT payment_status, stripe_payment_intent_id FROM orders WHERE id='o1'")
      .first()
  ).toEqual({ payment_status: 'disputed', stripe_payment_intent_id: 'pi_ours' });
});

it('poison event stays visible', async () => {
  await deliverStripeEvent(db, offline, disputeCreated('evt_poison', 'pi_unknown'), 'sig').catch(
    () => false
  );
  for (let attempt = 1; attempt < 5; attempt++) await retryNow('evt_poison', undefined);

  expect(await inboxRow('evt_poison')).toEqual({ status: 'dead', attempts: 5 });
  expect(sessionFor).not.toHaveBeenCalled();
  const alert = await db
    .prepare(
      "SELECT payload_json FROM outbox WHERE id='inbox-alert-evt_poison-ops@example.invalid'"
    )
    .first<{ payload_json: string }>();
  expect(JSON.parse(alert?.payload_json ?? '{}')).toMatchObject({
    to: 'ops@example.invalid',
    subject: 'Webhook processing failed permanently: charge.dispute.created',
  });
});

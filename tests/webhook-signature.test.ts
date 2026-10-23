import { afterAll, beforeAll, expect, it } from 'vitest';
import Stripe from '../web/node_modules/stripe';
import { StripeProvider, WebhookSignatureError } from '../web/src/server/payments';
import { inboxStripeEvent } from '../web/src/server/checkout';
import { REQUIRED_STRIPE_EVENTS, stripeListenArguments } from '../web/src/server/stripe-events';
import { createTestDb } from './helpers/d1';

const secret = 'whsec_isolated_fixture';
const stripe = new Stripe('sk_test_isolated_fixture');
const provider = new StripeProvider('sk_test_isolated_fixture', secret);
let db: D1Database, dispose: () => Promise<void>;
beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
});
afterAll(async () => dispose());

it('forwards every required event and verifies signed deliveries without provider network calls', async () => {
  const args = stripeListenArguments('http://localhost:8799');
  expect(args).toEqual([
    'listen',
    '--latest',
    '--forward-to',
    'http://localhost:8799/api/webhooks/stripe',
    '--events',
    REQUIRED_STRIPE_EVENTS.join(','),
  ]);
  for (const type of REQUIRED_STRIPE_EVENTS) {
    const eventId = `evt_signed_${type.replaceAll('.', '_')}`;
    const payload = JSON.stringify({
      id: eventId,
      object: 'event',
      type,
      data: { object: { id: 'fixture' } },
    });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect(await inboxStripeEvent(db, provider, payload, signature)).toEqual({
      eventId,
      duplicate: false,
    });
    expect(await inboxStripeEvent(db, provider, payload, signature)).toEqual({
      eventId,
      duplicate: true,
    });
    await expect(inboxStripeEvent(db, provider, `${payload} `, signature)).rejects.toThrow();
  }
  expect(
    (await db.prepare('SELECT COUNT(*) AS n FROM webhook_inbox').first<{ n: number }>())?.n
  ).toBe(REQUIRED_STRIPE_EVENTS.length);
});

it('a delivery with a bad signature is rejected as a signature error', async () => {
  const payload = JSON.stringify({ id: 'evt_forged', object: 'event', type: 'refund.updated' });
  await expect(provider.verifyWebhook(payload, 't=1,v1=forged')).rejects.toBeInstanceOf(
    WebhookSignatureError
  );
});

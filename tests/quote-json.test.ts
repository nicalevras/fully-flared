import { afterEach, beforeEach, expect, it } from 'vitest';
import { prepareReview } from '../web/src/server/authorized-checkout';
import { CheckoutError } from '../web/src/server/checkout';
import { createTestDb } from './helpers/d1';
import { fakeProvider } from './helpers/payments';

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
});
afterEach(async () => {
  await dispose();
});
const provider = fakeProvider({});
const cached = (quoteJson: string) => ({
  id: 'intent-1',
  order_id: 'order-1',
  quote_json: quoteJson,
  stripe_session_id: null,
  provider_payload_json: '{}',
  shipping_address_json: null,
});

it.each([
  ['not JSON', '{"totalCents":'],
  ['wrong shape', '{"totalCents":"12","currency":"USD"}'],
])('malformed cached quote returns 409 instead of crashing (%s)', async (_name, quoteJson) => {
  const review = prepareReview(db, provider, cached(quoteJson), Date.now() + 1000);
  await expect(review).rejects.toBeInstanceOf(CheckoutError);
  await expect(review).rejects.toMatchObject({ status: 409, code: 'STALE_QUOTE' });
});

it('a well-formed cached quote is returned as stored', async () => {
  const quote = {
    subtotalCents: 2000,
    discountCents: 0,
    shippingCents: 500,
    taxCents: 0,
    totalCents: 2500,
    currency: 'USD',
  };
  await expect(
    prepareReview(db, provider, cached(JSON.stringify(quote)), Date.now() + 1000)
  ).resolves.toEqual(quote);
});

import { expect, it } from 'vitest';
import { prepareReview } from '../web/src/server/authorized-checkout';
import { CheckoutError } from '../web/src/server/checkout';

const db = {};
const provider = {};

it.each([
  ['not JSON', '{"totalCents":'],
  ['wrong shape', '{"totalCents":"12","currency":"USD"}'],
])('malformed cached quote returns 409 instead of crashing (%s)', async (_name, quoteJson) => {
  const review = prepareReview(db, provider, { quote_json: quoteJson }, Date.now() + 1000);
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
    prepareReview(db, provider, { quote_json: JSON.stringify(quote) }, Date.now() + 1000)
  ).resolves.toEqual(quote);
});

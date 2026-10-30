import { describe, expect, it } from 'vitest';
import { checkoutResponseSchema } from '../web/src/schemas/checkout';

const quote = {
  subtotalCents: 1000,
  discountCents: 0,
  shippingCents: 500,
  taxCents: 0,
  totalCents: 1500,
  currency: 'USD',
};

describe('checkout response boundary', () => {
  it('accepts every server response shape', () => {
    for (const body of [
      {
        state: 'review_ready',
        intentId: 'i1',
        orderId: 'o1',
        quote,
        quoteHash: 'h',
        expiresAt: 'x',
      },
      { state: 'review_ready', intentId: 'i1', orderId: 'o1', quote, quoteHash: null },
      { state: 'already_paid', orderId: 'o1', orderUrl: '/checkout/success?order=o1' },
      { state: 'pending', orderId: 'o1' },
      { checkoutUrl: 'https://checkout.stripe.com/x' },
      { error: 'Your cart changed.', code: 'STALE_ATTEMPT' },
    ]) {
      expect(() => checkoutResponseSchema.parse(body)).not.toThrow();
    }
  });

  it('rejects a malformed quote instead of rendering it', () => {
    expect(() =>
      checkoutResponseSchema.parse({ state: 'review_ready', quote: { totalCents: 'NaN' } })
    ).toThrow();
  });
});

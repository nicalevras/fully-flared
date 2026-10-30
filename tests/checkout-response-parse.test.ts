import { describe, expect, it } from 'vitest';
import { parseCheckoutResponse } from '../web/src/lib/checkout-intent';

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
      expect(() => parseCheckoutResponse(body)).not.toThrow();
    }
  });

  it('drops a null quote hash so the review is not offered', () => {
    expect(parseCheckoutResponse({ state: 'review_ready', quote, quoteHash: null }).quoteHash).toBe(
      undefined
    );
  });

  it('rejects a body that is not an object', () => {
    expect(() => parseCheckoutResponse(null)).toThrow();
  });

  it('rejects a malformed quote instead of rendering it', () => {
    expect(() =>
      parseCheckoutResponse({ state: 'review_ready', quote: { totalCents: 'NaN' } })
    ).toThrow();
  });
});

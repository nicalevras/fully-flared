import { expect, it, vi } from 'vitest';
import type Stripe from '../web/node_modules/stripe';
import { StripeProvider, type CheckoutRequest } from '../web/src/server/payments';

vi.mock('../web/src/server/env', () => ({ workerEnv: {} }));

it('uses Stripe 23 supported card allowlist for manual-capture Checkout Sessions', async () => {
  const provider = new StripeProvider('sk_test_fixture', 'whsec_fixture');
  const stripe = (provider as unknown as { stripe: Stripe }).stripe;
  const create = vi.spyOn(stripe.checkout.sessions, 'create').mockResolvedValue({
    id: 'cs_fixture',
    url: 'https://checkout.stripe.com/fixture',
  } as Stripe.Response<Stripe.Checkout.Session>);
  const request: CheckoutRequest = {
    orderId: 'order-fixture',
    attemptId: 'attempt-fixture',
    email: 'fixture@example.test',
    currency: 'USD',
    lineItems: [{ name: 'Fixture', unitAmountCents: 1000, qty: 1 }],
    successUrl: 'https://example.test/checkout/success',
    cancelUrl: 'https://example.test/checkout',
    shippingCents: 0,
    collectShipping: false,
    shippingCountries: ['US'],
    automaticTax: false,
    expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 1920,
    manualCapture: true,
    customerId: 'cus_fixture',
    shippingAddress: {
      name: 'Fixture',
      line1: '1 Test Street',
      line2: '',
      city: 'Test',
      state: 'NY',
      postalCode: '10001',
      country: 'US',
      phone: '',
    },
  };
  await provider.createCheckoutSession(request);
  const params = create.mock.calls[0]![0]!;
  expect(params.allowed_payment_method_types).toEqual(['card']);
  expect(params).not.toHaveProperty('payment_method_types');
  expect(params.payment_intent_data?.capture_method).toBe('manual');
  expect(params.customer).toBe('cus_fixture');
  expect(params).not.toHaveProperty('shipping_address_collection');
  create.mockRestore();
});

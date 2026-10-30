import { afterEach, expect, it, vi } from 'vitest';
import { StripeProvider, type CheckoutRequest } from '../web/src/server/payments';
import { at } from './helpers/fixtures';
import { paramKeys, stubStripeHttp } from './helpers/stripe-http';

vi.mock('../web/src/server/env', () => ({ workerEnv: {} }));
afterEach(() => {
  vi.unstubAllGlobals();
});

function sessionCreated(id: string) {
  return stubStripeHttp(() =>
    Response.json({ id, object: 'checkout.session', url: 'https://checkout.stripe.com/fixture' })
  );
}

it('uses Stripe 23 supported card allowlist for manual-capture Checkout Sessions', async () => {
  const provider = new StripeProvider('sk_test_fixture', 'whsec_fixture');
  const requests = sessionCreated('cs_fixture');
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
  const { url, params } = at(requests, 0);
  expect(url.pathname).toBe('/v1/checkout/sessions');
  expect(paramKeys(params, 'allowed_payment_method_types')).toEqual([
    'allowed_payment_method_types[0]',
  ]);
  expect(params.get('allowed_payment_method_types[0]')).toBe('card');
  expect(paramKeys(params, 'payment_method_types')).toEqual([]);
  expect(params.get('payment_intent_data[capture_method]')).toBe('manual');
  expect(params.get('customer')).toBe('cus_fixture');
  expect(paramKeys(params, 'shipping_address_collection')).toEqual([]);
});

it('enables automatic tax without any per-product tax code', async () => {
  const provider = new StripeProvider('sk_test_fixture', 'whsec_fixture');
  const requests = sessionCreated('cs_fixture_tax');
  const request: CheckoutRequest = {
    orderId: 'order-fixture-tax',
    attemptId: 'attempt-fixture-tax',
    email: 'fixture@example.test',
    currency: 'USD',
    lineItems: [{ name: 'Fixture', unitAmountCents: 1000, qty: 1 }],
    successUrl: 'https://example.test/checkout/success',
    cancelUrl: 'https://example.test/checkout',
    shippingCents: 0,
    collectShipping: false,
    shippingCountries: ['US'],
    automaticTax: true,
    expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 1920,
  };
  await provider.createCheckoutSession(request);
  const { params } = at(requests, 0);
  expect(paramKeys(params, 'automatic_tax')).toEqual(['automatic_tax[enabled]']);
  expect(params.get('automatic_tax[enabled]')).toBe('true');
  expect(paramKeys(params, 'line_items[0][price_data][product_data][tax_code]')).toEqual([]);
});

it('forwards every shipping country to Stripe unfiltered, so Stripe rejects unsupported codes', async () => {
  const provider = new StripeProvider('sk_test_fixture', 'whsec_fixture');
  const requests = sessionCreated('cs_fixture_countries');
  await provider.createCheckoutSession({
    orderId: 'order-fixture-countries',
    attemptId: 'attempt-fixture-countries',
    email: 'fixture@example.test',
    currency: 'USD',
    lineItems: [{ name: 'Fixture', unitAmountCents: 1000, qty: 1 }],
    successUrl: 'https://example.test/checkout/success',
    cancelUrl: 'https://example.test/checkout',
    collectShipping: true,
    shippingCountries: ['US', 'QQ'],
    automaticTax: false,
    expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 1920,
  });
  const { params } = at(requests, 0);
  expect(paramKeys(params, 'shipping_address_collection[allowed_countries]')).toEqual([
    'shipping_address_collection[allowed_countries][0]',
    'shipping_address_collection[allowed_countries][1]',
  ]);
  expect(params.get('shipping_address_collection[allowed_countries][0]')).toBe('US');
  expect(params.get('shipping_address_collection[allowed_countries][1]')).toBe('QQ');
});

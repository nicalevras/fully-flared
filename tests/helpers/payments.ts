import type { PaymentProvider } from '../../web/src/server/payments';

function notUnderTest(name: string): never {
  throw new Error(`${name} is not part of this test`);
}

/** A payment provider with only the calls the test answers; the required ones it leaves out throw. */
export function fakeProvider(calls: Partial<PaymentProvider>): PaymentProvider {
  return {
    createCheckout: async () => notUnderTest('createCheckout'),
    verifyWebhook: async () => notUnderTest('verifyWebhook'),
    refund: async () => notUnderTest('refund'),
    ...calls,
  };
}

/** The function type of one provider call, for typed mocks: vi.fn<ProviderCall<'refund'>>(). */
export type ProviderCall<K extends keyof PaymentProvider> = NonNullable<PaymentProvider[K]>;

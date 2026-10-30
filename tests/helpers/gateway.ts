import type { GatewayContext } from '../../web/src/server';

export type Storefront = GatewayContext['exports']['PublicStorefront'];

function notUnderTest(): never {
  throw new Error('the PublicStorefront entrypoint is not part of this test');
}

const absentStorefront: Storefront = Object.assign(notUnderTest, {
  purgeInvalidations: async () => notUnderTest(),
});

/** The gateway's ExecutionContext: the test can await what it was handed through waitUntil. */
export function gatewayContext(
  storefront: Storefront = absentStorefront
): GatewayContext & { pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil: (promise) => void pending.push(promise),
    exports: { PublicStorefront: storefront },
  };
}

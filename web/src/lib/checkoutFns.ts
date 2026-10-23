import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseStatus } from '@tanstack/react-start/server';
import { validateServerInput } from '../server/function-boundary';
import { checkoutConfirmSchema } from '../schemas/checkout';
import { getSessionUser } from '../server/session';
import { loadIntent, intentOwnedBy, parseGuestCapability } from '../server/checkout-intents';
import { confirmReview } from '../server/authorized-checkout';
import { CheckoutError } from '../server/checkout';
import { cartIdentity, parseCartCookie } from '../server/cart';

export const confirmCheckoutFn = createServerFn({ method: 'POST' })
  .validator(validateServerInput(checkoutConfirmSchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const request = getRequest(),
      intent = await loadIntent(env.DB, data.intentId);
    const user = await getSessionUser(env.DB, request);
    if (
      !intent ||
      !(await intentOwnedBy(intent, {
        userId: user?.id ?? null,
        guestToken: parseGuestCapability(request.headers.get('cookie')),
      }))
    )
      throw new CheckoutError('Checkout not found', 404, 'NOT_FOUND');
    const cart = await cartIdentity(env.DB, parseCartCookie(request.headers.get('cookie')));
    if (
      !cart ||
      cart.status !== 'open' ||
      cart.id !== intent.cart_id ||
      cart.revision !== intent.cart_revision
    ) {
      setResponseStatus(409);
      return {
        ok: false as const,
        code: 'STALE_ATTEMPT',
        error: 'Your cart changed. Reload it and review your order again.',
      };
    }
    try {
      return {
        ok: true as const,
        checkoutUrl: await confirmReview(env.DB, data.intentId, data.quoteHash),
      };
    } catch (error) {
      if (!(error instanceof CheckoutError) || error.status !== 409) throw error;
      setResponseStatus(409);
      return { ok: false as const, code: 'STALE_ATTEMPT', error: error.message };
    }
  });

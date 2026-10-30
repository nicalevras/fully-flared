import { createServerFn } from '@tanstack/react-start';
import { validateServerInput } from '../server/function-boundary';
import {
  appendResponseHeader,
  getRequest,
  setResponseHeader,
  setResponseStatus,
} from '@tanstack/react-start/server';
import {
  addCartLine,
  cartCookieHeader,
  cartIdentity,
  clearCart,
  cartCountCookieHeader,
  clearCartCookieHeader,
  getCartLines,
  getShippingZones,
  parseCartCookie,
  priceCartLines,
  setCartLine,
  type PricedLine,
  type ShippingZoneView,
} from '../server/cart';
import { cartAddSchema, cartLineMutationSchema } from '../schemas/cart';
import { getSettings } from '../server/settings';
import { storefrontLimited } from '../server/storefront-limit';
import type { StoreLimits } from './settings-definitions';

export type CartView = {
  cartId: string | null;
  cartRevision: number | null;
  limits: StoreLimits;
  lines: PricedLine[];
  zones: ShippingZoneView[];
  count: number;
};

async function cartView(
  db: D1Database,
  creds: Parameters<typeof getCartLines>[1]
): Promise<CartView> {
  const lines = await priceCartLines(db, await getCartLines(db, creds));
  const identity = await cartIdentity(db, creds);
  return {
    cartId: identity?.status === 'open' ? identity.id : null,
    cartRevision: identity?.status === 'open' ? identity.revision : null,
    lines,
    limits: (await getSettings(db)).limits,
    zones: await getShippingZones(db),
    count: lines.reduce((n, l) => n + l.qty, 0),
  };
}

/** Cart writes reach D1 on every call, and a cookieless one inserts a cart,
 *  so each network gets the storefront budget for them. */
async function rejectWhenLimited(limiter: Parameters<typeof storefrontLimited>[0]) {
  if (await storefrontLimited(limiter, 'cart', getRequest())) {
    setResponseStatus(429);
    throw new Error('Too many cart changes. Try again in a minute.');
  }
}

export const getCart = createServerFn({ method: 'GET' }).handler(async (): Promise<CartView> => {
  const { env } = await import('cloudflare:workers');
  const creds = parseCartCookie(getRequest().headers.get('cookie'));
  return cartView(env.DB, creds);
});

export const setCartLineFn = createServerFn({ method: 'POST' })
  .validator(validateServerInput(cartLineMutationSchema))
  .handler(async ({ data }): Promise<CartView> => {
    const { env } = await import('cloudflare:workers');
    await rejectWhenLimited(env.STOREFRONT_LIMITER);
    const creds = parseCartCookie(getRequest().headers.get('cookie'));
    const result = await setCartLine(env.DB, creds, data.sku, data.qty);
    if (result.created) setResponseHeader('Set-Cookie', cartCookieHeader(result.creds));
    const view = await cartView(env.DB, result.creds);
    appendResponseHeader('Set-Cookie', cartCountCookieHeader(view.count));
    return view;
  });

export const addCartLineFn = createServerFn({ method: 'POST' })
  .validator(validateServerInput(cartAddSchema))
  .handler(async ({ data }): Promise<CartView> => {
    const { env } = await import('cloudflare:workers');
    await rejectWhenLimited(env.STOREFRONT_LIMITER);
    const creds = parseCartCookie(getRequest().headers.get('cookie'));
    const result = await addCartLine(env.DB, creds, data.sku, data.qty);
    if (result.created) setResponseHeader('Set-Cookie', cartCookieHeader(result.creds));
    const view = await cartView(env.DB, result.creds);
    appendResponseHeader('Set-Cookie', cartCountCookieHeader(view.count));
    return view;
  });

export const clearCartFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<CartView> => {
    const { env } = await import('cloudflare:workers');
    const creds = parseCartCookie(getRequest().headers.get('cookie'));
    await clearCart(env.DB, creds);
    setResponseHeader('Set-Cookie', clearCartCookieHeader);
    appendResponseHeader('Set-Cookie', cartCountCookieHeader(0));
    return cartView(env.DB, null);
  }
);

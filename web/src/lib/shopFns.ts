import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import { validateServerInput } from '../server/function-boundary';
import { getRequest, setResponseStatus } from '@tanstack/react-start/server';
import {
  discountValidateBodySchema,
  returnCreateBodySchema,
  checkoutQuoteSchema,
} from '../schemas/checkout';
import { normalizeNetwork } from '../server/network';
import { calculateDiscount, quoteOrder } from '../server/checkout';
import { AuthError, getRequestAuth, getSessionUser } from '../server/session';
import { accountActionSchema } from '../schemas/account';
import { saveAddress } from '../server/account-addresses';
import { APIError } from 'better-auth/api';
import type { Auth } from './auth';

type RateLimiterBinding = { limit: (opts: { key: string }) => Promise<{ success: boolean }> };

/** Discount guessing uses the network bucket, independent of submitted email.
 * Missing or failed limiter bindings refuse attempts. */
export async function discountAttemptLimited(
  env: { AUTH_LIMITER?: RateLimiterBinding },
  identity: string
): Promise<boolean> {
  const limiter = env.AUTH_LIMITER;
  if (!limiter) return true;
  try {
    const result = await limiter.limit({ key: `discount:${identity}` });
    return !result.success;
  } catch {
    return true;
  }
}

export const discountNetworkIdentity = createServerOnlyFn((): string => {
  try {
    return normalizeNetwork(getRequest().headers.get('CF-Connecting-IP') ?? 'unknown');
  } catch {
    console.warn(JSON.stringify({ event: 'discount_request_context_unavailable' }));
    return 'unknown';
  }
});

/** Discount preview for cart/checkout (replaces /api/discount/validate). */
export const validateDiscountFn = createServerFn({ method: 'POST' })
  .validator(validateServerInput(discountValidateBodySchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    if (
      await discountAttemptLimited(
        env as { AUTH_LIMITER?: RateLimiterBinding },
        discountNetworkIdentity()
      )
    ) {
      return {
        valid: false as const,
        limited: true as const,
        error: 'Too many discount attempts. Please wait a minute and try again.',
      };
    }
    // Only the signed-in account's own usage is checked here; a typed email
    // would turn the per-customer cap into an account-usage oracle. Checkout
    // enforces the cap for every order.
    const user = await getSessionUser(env.DB, getRequest());
    const discount = await calculateDiscount(
      env.DB,
      data.code,
      data.subtotalCents,
      user?.email ?? null
    );
    if (!discount) return { valid: false as const, error: 'Code is not valid for this order' };
    return { valid: true as const, code: discount.code, amountCents: discount.amountCents };
  });

export const checkoutQuoteFn = createServerFn({ method: 'POST' })
  .validator(validateServerInput(checkoutQuoteSchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    if (data.discountCode && (await discountAttemptLimited(env, discountNetworkIdentity()))) {
      setResponseStatus(429);
      throw new Error('Too many discount attempts');
    }
    const user = data.discountCode ? await getSessionUser(env.DB, getRequest()) : null;
    return quoteOrder(env.DB, { ...data, discountUsageEmail: user?.email ?? null });
  });

/** Create a return request for the signed-in customer's own order
 * (replaces /api/returns). Ownership and state checks match the old route. */
export const createReturnFn = createServerFn({ method: 'POST' })
  .validator(validateServerInput(returnCreateBodySchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const user = await getSessionUser(env.DB, getRequest());
    if (!user) throw new AuthError('UNAUTHENTICATED', 'Sign in required');
    const order = await env.DB.prepare(
      'SELECT id, user_id, payment_status FROM orders WHERE id = ?'
    )
      .bind(data.orderId)
      .first<{ id: string; user_id: string | null; payment_status: string }>();
    if (!order || order.user_id !== user.id)
      return { ok: false as const, error: 'Order not found' };
    if (order.payment_status !== 'paid' && order.payment_status !== 'partially_refunded')
      return { ok: false as const, error: 'Only paid orders can be returned' };
    const existing = await env.DB.prepare(
      "SELECT id FROM returns WHERE order_id = ? AND status IN ('requested','approved')"
    )
      .bind(data.orderId)
      .first();
    if (existing)
      return { ok: false as const, error: 'A return is already in progress for this order' };
    const { insertReturnRequest, validateReturnItems } = await import('../server/returns');
    const validated = await validateReturnItems(env.DB, data.orderId, data.items);
    if (!validated.ok) return validated;
    return insertReturnRequest(env.DB, data.orderId, user.id, data.reason, validated.items);
  });

/** Customer self-service mutations: address book + account deletion
 * (replaces the POST half of /api/account; the GET export stays a raw
 * route because it is a file download). Only the caller's own rows. */
export const accountActionFn = createServerFn({ method: 'POST' })
  .validator(validateServerInput(accountActionSchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const request = getRequest();
    const user = await getSessionUser(env.DB, request);
    if (!user) throw new AuthError('UNAUTHENTICATED', 'Sign in required');
    const db = env.DB;

    if (data.action === 'address.create' || data.action === 'address.update')
      return saveAddress(db, user.id, data);
    if (data.action === 'address.delete') {
      await db
        .prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?')
        .bind(data.addressId, user.id)
        .run();
      return { ok: true as const };
    }

    // account.delete
    if (data.confirmEmail !== user.email) {
      return { ok: false as const, error: 'Type your account email to confirm deletion' };
    }
    return deleteSignedInAccount(await getRequestAuth(db, request), request.headers);
  });

/** Better Auth deletes without a password only from a session younger than freshAge. */
export async function deleteSignedInAccount(
  auth: Auth,
  headers: Headers
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await auth.api.deleteUser({ headers, body: {} });
    return { ok: true };
  } catch (err) {
    if (err instanceof APIError && err.body?.code === 'SESSION_EXPIRED')
      return { ok: false, error: 'Sign in again to delete your account' };
    return { ok: false, error: err instanceof Error ? err.message : 'Account deletion failed' };
  }
}

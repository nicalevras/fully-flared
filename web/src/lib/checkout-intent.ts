// Checkout intent identity (Phase 1). Only the intent ID and an input
// digest live in sessionStorage — never email, provider payloads or
// capability secrets (the guest capability is an HttpOnly cookie).

import { sha256Hex } from './hash';

export type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const ID_KEY = 'checkout-intent-id';
const INPUT_KEY = 'checkout-intent-input';

export async function checkoutInputKey(input: {
  cartId: string;
  cartRevision: number;
  quoteRevision?: number | undefined;
  confirmedQuote?: import('../schemas/checkout').CheckoutBody['confirmedQuote'];
  email: string;
  lines: { sku: string; qty: number }[];
  shippingCountry: string;
  shippingRateId: string;
  discountCode?: string | undefined;
  shippingAddress?: import('../schemas/checkout').ShippingAddress;
  reminderConsent?: boolean;
}): Promise<string> {
  const merged = new Map<string, number>();
  for (const l of input.lines) merged.set(l.sku, (merged.get(l.sku) ?? 0) + l.qty);
  // Only the digest is ever stored: the canonical form contains the
  // shopper's email, which does not belong in browser storage.
  return sha256Hex(
    JSON.stringify({
      cartId: input.cartId,
      cartRevision: input.cartRevision,
      quoteRevision: input.quoteRevision,
      quote: input.confirmedQuote,
      email: input.email.trim().toLowerCase(),
      lines: [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      country: input.shippingCountry,
      rate: input.shippingRateId,
      coupon: (input.discountCode ?? '').trim().toUpperCase(),
      address: input.shippingAddress,
      reminderConsent: input.reminderConsent ?? false,
    })
  );
}

let memoryIntent: { intentId: string; inputKey: string } | null = null;

/** Reuse the stored intent for unchanged inputs (double-clicks, network
 *  failures, manual retries); mint a new one after material changes. */
export function getCheckoutIntent(
  storage: IntentStorage | undefined,
  inputKey: string
): { intentId: string; fresh: boolean } {
  try {
    if (!storage) throw new Error('Browser storage unavailable');
    const id = storage.getItem(ID_KEY);
    if (id && storage.getItem(INPUT_KEY) === inputKey) return { intentId: id, fresh: false };
    const intentId = crypto.randomUUID();
    storage.setItem(ID_KEY, intentId);
    storage.setItem(INPUT_KEY, inputKey);
    return { intentId, fresh: true };
  } catch {
    // Storage unavailable (private mode, disabled): keep one stable
    // in-memory identity for unchanged inputs for this page's
    // lifetime, so retries still deduplicate instead of minting a
    // fresh intent on every attempt.
    if (memoryIntent?.inputKey === inputKey)
      return { intentId: memoryIntent.intentId, fresh: false };
    const intentId = crypto.randomUUID();
    memoryIntent = { intentId, inputKey };
    return { intentId, fresh: true };
  }
}

export function resetCheckoutIntent(storage: IntentStorage | undefined): void {
  memoryIntent = null;
  try {
    storage?.removeItem(ID_KEY);
    storage?.removeItem(INPUT_KEY);
  } catch {
    // Nothing stored; nothing to reset.
  }
}

/** Minimal structural view of the Web Locks API used for bootstrap. */
export type GuestBootstrapLocks = {
  request(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<void>
  ): Promise<void>;
};

/** Establish the guest capability cookie before any commerce state
 *  exists. The exclusive Web Lock is held across the whole bootstrap
 *  round-trip, so two initially-empty tabs cannot mint competing
 *  capabilities and overwrite each other's cookie. When Web Locks is
 *  unavailable there is no safe serialization: fail closed (return
 *  false) and create no commerce state — never fall back to
 *  localStorage leases or unserialized bootstrap. */
export async function ensureGuestBootstrap(
  locks: GuestBootstrapLocks | undefined,
  bootstrap: () => Promise<void>
): Promise<boolean> {
  if (!locks) return false;
  await locks.request('guest-bootstrap', { mode: 'exclusive' }, async () => {
    await bootstrap();
  });
  return true;
}

export type CheckoutResponseAction =
  | { kind: 'redirect'; url: string }
  | { kind: 'paid'; orderId: string }
  | { kind: 'pending'; orderId?: string }
  | { kind: 'error'; message: string; terminal: boolean };

/** Map a typed /api/checkout response to the page's next step. Terminal
 *  outcomes (conflict, ended attempt) tell the caller to reset the
 *  stored intent so the next click starts a fresh attempt. */
export function classifyCheckoutResponse(
  status: number,
  data: {
    checkoutUrl?: string | undefined;
    state?: string | undefined;
    orderId?: string | undefined;
    error?: string | undefined;
  }
): CheckoutResponseAction {
  if (status === 200 && data.checkoutUrl) return { kind: 'redirect', url: data.checkoutUrl };
  if (status === 200 && data.state === 'already_paid' && data.orderId)
    return { kind: 'paid', orderId: data.orderId };
  if (status === 202)
    return data.orderId ? { kind: 'pending', orderId: data.orderId } : { kind: 'pending' };
  return {
    kind: 'error',
    message: data.error ?? 'Checkout failed. Your cart is unchanged.',
    terminal: status === 409,
  };
}

/** Reading the storage property itself can throw in restricted browsers. */
export function checkoutStorage(): IntentStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

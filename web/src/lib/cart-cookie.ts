/** A cosmetic count only. The HttpOnly cart capability remains server-owned. */
export function cartCountFromCookie(header: string | null): number {
  const value = header
    ?.split(';')
    .find((part) => part.trim().startsWith('cart_count='))
    ?.split('=')[1];
  const count = Number(value ?? 0);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

/** localStorage key whose `storage` event tells other tabs to reread the count cookie. */
export const CART_COUNT_SIGNAL = 'cart-count';

export function signalCartCount(count: number) {
  try {
    localStorage.setItem(CART_COUNT_SIGNAL, String(count));
  } catch {
    /* Blocked storage only costs other tabs the live update; they reread the cookie on load. */
  }
}

/** The count carried by a `cart-changed` event, if it carries one. */
export function cartChangedCount(event: Event): number | undefined {
  if (!(event instanceof CustomEvent)) return undefined;
  const detail: unknown = event.detail;
  return typeof detail === 'object' &&
    detail !== null &&
    'count' in detail &&
    typeof detail.count === 'number'
    ? detail.count
    : undefined;
}

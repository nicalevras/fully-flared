import { useCallback, useEffect, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { addCartLineFn, clearCartFn, getCart, setCartLineFn, type CartView } from './cartFns';
import type { PricedLine, ShippingZoneView } from '../server/cart';
import { formatMoney } from './format';
import { signalCartCount } from './cart-cookie';

// Client cart state is a mirror of the server cart (D1 + capability
// cookie). Loaders seed the first render with priced lines, mutations go
// through server functions, and the header badge updates from the
// `cart-changed` event each mutation dispatches; other tabs hear the count
// through a localStorage signal. The cart itself never lives in
// localStorage, so SSR and the browser can never disagree.
export type { CartView, PricedLine, ShippingZoneView };

declare global {
  interface WindowEventMap {
    'cart-changed': CustomEvent<{ count: number; view: CartView } | null>;
  }
}
export type ZoneRate = ShippingZoneView['rates'][number];
export type Zone = ShippingZoneView;

export function openCart() {
  window.dispatchEvent(new Event('cart-open'));
}

let recentView: { view: CartView; at: number } | null = null;
let inFlightView: Promise<CartView> | null = null;
let mutationRevision = 0;
function dispatchCartChanged(view: CartView) {
  mutationRevision++;
  recentView = { view, at: Date.now() };
  window.dispatchEvent(new CustomEvent('cart-changed', { detail: { count: view.count, view } }));
  signalCartCount(view.count);
}

export class CartLockUnavailableError extends Error {
  constructor() {
    super(
      'Cart needs a browser with tab coordination (Web Locks). Try a current browser; nothing was added.'
    );
    this.name = 'CartLockUnavailableError';
  }
}

/** Minimal structural view of the Web Locks API used for cart mutations. */
export type CartMutationLocks = {
  request<R>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<R>): Promise<R>;
};

function browserCartLocks(): CartMutationLocks | undefined {
  return typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined;
}

/** Serialize cart-creating mutations across tabs, mirroring
 * ensureGuestBootstrap: the exclusive lock is held across the whole
 * round-trip, so a second tab's request only leaves after the first
 * response has set the cart cookie. No Web Locks means no safe
 * serialization — fail closed and create nothing. */
export async function withCartMutationLock<T>(
  locks: CartMutationLocks | undefined,
  run: () => Promise<T>
): Promise<T> {
  if (!locks) throw new CartLockUnavailableError();
  return locks.request('cart-mutation', { mode: 'exclusive' }, run);
}

export async function addToCart(sku: string, qty: number): Promise<void> {
  const view = await withCartMutationLock(browserCartLocks(), () =>
    addCartLineFn({ data: { sku, qty } })
  );
  dispatchCartChanged(view);
}

export async function clearCart(): Promise<void> {
  const view = await clearCartFn();
  dispatchCartChanged(view);
}

export function rateCost(r: ZoneRate, subtotal: number, weightGrams = 0) {
  return r.kind === 'free_over' && r.freeOverCents != null && subtotal >= r.freeOverCents
    ? 0
    : r.amountCents +
        (r.kind === 'weight' ? Math.ceil(weightGrams / 1000) * (r.perKgCents ?? 0) : 0);
}

/** Quantity after a "+" click: one more, capped at the configured limit,
 * and never below the quantity already in the cart — a lowered limit or
 * dropped stock must not make "+" shrink or remove the line. Stock itself
 * is enforced at checkout. */
export function nextQtyOnIncrement(qty: number, limit: number) {
  return qty >= limit ? qty : Math.min(limit, qty + 1);
}

/** The zone serving a country, or undefined when the store does not
 * deliver there. No first-zone fallback: quoting another destination's
 * rates would misstate shipping and totals. */
export function zoneForCountry(zones: Zone[], country: string): Zone | undefined {
  return zones.find((z) => z.countries.includes(country));
}

/** Delivery option label: the full calculated cost (weight surcharges
 * included), matching the order summary, or Free when it calculates to 0. */
export function ratePriceLabel(
  r: ZoneRate,
  subtotal: number,
  weightGrams: number,
  currency: string
) {
  const cost = rateCost(r, subtotal, weightGrams);
  return cost === 0 ? 'Free' : formatMoney(cost, currency);
}

export function useServerCart(initial: CartView) {
  const [view, setView] = useState<CartView>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const changed = (event: WindowEventMap['cart-changed']) => {
      const next = event.detail?.view;
      if (next) setView(next);
    };
    window.addEventListener('cart-changed', changed);
    return () => window.removeEventListener('cart-changed', changed);
  }, []);
  const read = useServerFn(getCart),
    write = useServerFn(setCartLineFn);
  const refresh = useCallback(
    async (force = false) => {
      try {
        const revision = mutationRevision;
        const next =
          !force && recentView && Date.now() - recentView.at < 5000
            ? recentView.view
            : await (inFlightView ??= read()
                .then((value) => {
                  if (revision !== mutationRevision && recentView) return recentView.view;
                  recentView = { view: value, at: Date.now() };
                  return value;
                })
                .finally(() => {
                  inFlightView = null;
                }));
        setView(next);
        setError('');
        return next;
      } catch {
        setError('Cart could not load. Try again.');
        return null;
      }
    },
    [read]
  );
  const setQty = useCallback(
    async (sku: string, qty: number) => {
      setPending(true);
      setError('');
      try {
        const next = await withCartMutationLock(browserCartLocks(), () =>
          write({ data: { sku, qty } })
        );
        setView(next);
        dispatchCartChanged(next);
      } catch (error) {
        setError(
          error instanceof CartLockUnavailableError
            ? error.message
            : 'Cart could not update. Try again.'
        );
      } finally {
        setPending(false);
      }
    },
    [write]
  );
  return { pending, error, view, lines: view.lines, zones: view.zones, setQty, refresh, setView };
}

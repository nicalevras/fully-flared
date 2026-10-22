import { useCallback, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { addCartLineFn, clearCartFn, getCart, setCartLineFn, type CartView } from './cartFns';
import type { PricedLine, ShippingZoneView } from '../server/cart';
import { formatMoney } from './format';

// Client cart state is a mirror of the server cart (D1 + capability
// cookie). Loaders seed the first render with priced lines, mutations go
// through server functions, and the header badge updates from the
// `cart-changed` event each mutation dispatches. There is no localStorage
// cart any more, so SSR and the browser can never disagree.
export type { CartView, PricedLine, ShippingZoneView };
export type ZoneRate = ShippingZoneView['rates'][number];
export type Zone = ShippingZoneView;

export function openCart() {
  window.dispatchEvent(new Event('cart-open'));
}

function dispatchCartChanged(count: number) {
  window.dispatchEvent(new CustomEvent('cart-changed', { detail: { count } }));
}

export async function addToCart(sku: string, qty: number): Promise<void> {
  const view = await addCartLineFn({ data: { sku, qty } });
  dispatchCartChanged(view.count);
}

export async function clearCart(): Promise<void> {
  await clearCartFn();
  dispatchCartChanged(0);
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
  const read = useServerFn(getCart),
    write = useServerFn(setCartLineFn);
  const refresh = useCallback(async () => {
    try {
      const next = await read();
      setView(next);
      setError('');
      return next;
    } catch {
      setError('Cart could not load. Try again.');
      return null;
    }
  }, [read]);
  const setQty = useCallback(
    async (sku: string, qty: number) => {
      setPending(true);
      setError('');
      try {
        const next = await write({ data: { sku, qty } });
        setView(next);
        dispatchCartChanged(next.count);
      } catch {
        setError('Cart could not update. Try again.');
      } finally {
        setPending(false);
      }
    },
    [write]
  );
  return { pending, error, view, lines: view.lines, zones: view.zones, setQty, refresh, setView };
}

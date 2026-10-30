import { useMemo, useSyncExternalStore } from 'react';
import type { Zone } from './cart';

const regionNames = new Intl.DisplayNames('en-US', { type: 'region' });

/** Every country some zone ships to, once each, in zone order. */
export function shippableCountries(zones: Zone[]): string[] {
  return [...new Set(zones.flatMap((z) => z.countries))];
}

export function countryName(code: string): string {
  return regionNames.of(code) ?? code;
}

let chosenCountry: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function chooseCountry(country: string) {
  chosenCountry = country;
  for (const listener of listeners) listener();
}

/** The shopper's destination, shared by the cart page and the cart drawer
 * for this page session; the first shippable country until they choose. */
export function useCartDestination(zones: Zone[]) {
  const countries = useMemo(() => shippableCountries(zones), [zones]);
  const chosen = useSyncExternalStore(
    subscribe,
    () => chosenCountry,
    () => null
  );
  return { countries, country: chosen ?? countries[0] ?? '', setCountry: chooseCountry };
}

import type { Zone } from './cart';

const regionNames = new Intl.DisplayNames('en-US', { type: 'region' });

/** Every country some zone ships to, once each, in zone order. */
export function shippableCountries(zones: Zone[]): string[] {
  return [...new Set(zones.flatMap((z) => z.countries))];
}

export function countryName(code: string): string {
  return regionNames.of(code) ?? code;
}

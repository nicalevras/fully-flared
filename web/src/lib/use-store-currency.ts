import { getRouteApi } from '@tanstack/react-router';

const rootApi = getRouteApi('__root__');

/** Store currency from the root layout loader (settings-backed snapshot). */
export function useStoreCurrency(): string {
  return rootApi.useLoaderData().currency;
}

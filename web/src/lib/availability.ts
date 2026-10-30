import { createIsomorphicFn, useServerFn } from '@tanstack/react-start';
import { getAvailabilityFn } from './availabilityFns';
import { useEffect, useState } from 'react';
import type {
  AvailabilityMode,
  AvailabilityInput,
  AvailabilityResponse,
  ProductAvailability,
} from '../schemas/availability';

export type AvailabilityById = Record<string, ProductAvailability>;
export type AvailabilityReader = (input: {
  data: AvailabilityInput;
}) => Promise<AvailabilityResponse>;
export type AvailabilitySeed = { at: number; products: AvailabilityById };
const pending = new WeakMap<AvailabilityReader, Map<string, Promise<ProductAvailability[]>>>();

async function readBatch(ids: string[], mode: AvailabilityMode, read: AvailabilityReader) {
  const data = { mode, ids };
  const key = JSON.stringify(data);
  let requests = pending.get(read);
  if (!requests) {
    requests = new Map();
    pending.set(read, requests);
  }
  const existing = requests.get(key);
  if (existing) return existing;
  const request = (async () => {
    const { products } = await read({ data });
    if (
      products.length !== ids.length ||
      !ids.every((id) => products.some((p) => p.id === id && (mode !== 'product' || !!p.variants)))
    )
      throw new Error('Incomplete availability');
    return products;
  })().finally(() => requests.delete(key));
  requests.set(key, request);
  return request;
}

/** One read for this page's data; no subscriptions, polling or automatic retries. */
export function loadPageAvailability(
  ids: string[],
  mode: AvailabilityMode,
  update: (value: AvailabilityById) => void,
  read: AvailabilityReader
) {
  let disposed = false;
  update({});
  const load = async () => {
    try {
      const distinct = [...new Set(ids)].sort();
      const batches: Promise<ProductAvailability[]>[] = [];
      for (let offset = 0; offset < distinct.length; offset += 50)
        batches.push(readBatch(distinct.slice(offset, offset + 50), mode, read));
      const products = (await Promise.all(batches)).flat();
      if (!disposed) update(Object.fromEntries(products.map((p) => [p.id, p])));
    } catch {
      /* Unknown availability deliberately leaves controls buyable. */
    }
  };
  void load();
  return () => {
    disposed = true;
  };
}

/** True only in the browser bundle, so SSR loaders never ask for stock. */
export const inBrowser = createIsomorphicFn()
  .server(() => false)
  .client(() => true);

/** Stamps loader-fetched stock with the client time it arrived. */
export function seedAvailability<T extends { availability: AvailabilityById | null }>(data: T) {
  return {
    ...data,
    availability: data.availability ? { at: Date.now(), products: data.availability } : null,
  };
}

// Matches defaultPreloadStaleTime: older seeds come from reused loader data.
const SEED_FRESH_MS = 10_000;

function seededReader(seed: AvailabilitySeed | null, read: AvailabilityReader): AvailabilityReader {
  if (!seed || Date.now() - seed.at >= SEED_FRESH_MS) return read;
  return async ({ data }) => {
    const products = data.ids.flatMap((id) => seed.products[id] ?? []);
    return products.length === data.ids.length ? { products } : read({ data });
  };
}

function idsFromKey(key: string): string[] {
  const parsed: unknown = JSON.parse(key);
  return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
}

export function useAvailability(
  ids: string[],
  mode: AvailabilityMode = 'products',
  pageKey = '',
  seed: AvailabilitySeed | null = null
): AvailabilityById {
  const read = useServerFn(getAvailabilityFn);
  const key = JSON.stringify([...new Set(ids)].sort());
  // Loader-owned identity changes with this page's data. A global location
  // subscription would refetch the departing page before Router unmounts it.
  const scope = `${pageKey}:${mode}:${key}`;
  const [state, setState] = useState<{ scope: string; value: AvailabilityById }>({
    scope: '',
    value: {},
  });
  useEffect(
    () =>
      loadPageAvailability(
        idsFromKey(key),
        mode,
        (value) => setState({ scope, value }),
        seededReader(seed, read)
      ),
    [key, mode, scope, read, seed]
  );
  return state.scope === scope ? state.value : {};
}

export function availabilityLabel(value?: ProductAvailability) {
  return value?.status === 'sold_out'
    ? 'Out of stock'
    : value?.status === 'backorder'
      ? 'Available on backorder'
      : value?.status === 'in_stock'
        ? 'In stock'
        : value?.status === 'unavailable'
          ? 'Unavailable'
          : '';
}

export function purchaseAvailability(
  sku: string | undefined,
  limit: number,
  product?: ProductAvailability
) {
  const variant = product?.variants?.find((v) => v.sku === sku);
  const unknown = !product;
  const buyable =
    !!sku &&
    (unknown ||
      (product.status !== 'unavailable' &&
        !!variant &&
        variant.available !== null &&
        (variant.available > 0 || variant.continueSelling)));
  const maxQty =
    unknown || variant?.continueSelling
      ? limit
      : Math.max(0, Math.min(limit, variant?.available ?? 0));
  return { buyable, maxQty, variant };
}

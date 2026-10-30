import { expect, it, vi } from 'vitest';
vi.mock('../web/src/lib/availabilityFns', () => ({ getAvailabilityFn: vi.fn() }));
import {
  loadPageAvailability,
  purchaseAvailability,
  type AvailabilityReader,
} from '../web/src/lib/availability';
import type { ProductAvailability, AvailabilityResponse } from '../web/src/schemas/availability';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
it('loads once and batches listings without subscriptions for cart changes, focus or time', async () => {
  const events = new EventTarget();
  const update = vi.fn();
  const read = vi.fn<AvailabilityReader>(async ({ data }) => ({
    products: data.ids.map((id) => ({ id, status: 'sold_out' as const })),
  }));
  const stop = loadPageAvailability(
    Array.from({ length: 100 }, (_, i) => 'p' + i),
    'products',
    update,
    read
  );
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  expect(update.mock.calls.at(-1)?.[0].p0.status).toBe('sold_out');
  for (const event of ['cart-added', 'cart-changed', 'focus', 'visibilitychange'])
    events.dispatchEvent(new Event(event));
  await flush();
  expect(read).toHaveBeenCalledTimes(2);
  stop();
});
it('failures remain unknown without retries; an unmounted page ignores a late response', async () => {
  const update = vi.fn();
  const read = vi.fn(async () => {
    throw new Error('offline');
  });
  const stop = loadPageAvailability(['p1'], 'product', update, read);
  await flush();
  expect(update.mock.calls.at(-1)?.[0]).toEqual({});
  await flush();
  expect(read).toHaveBeenCalledTimes(1);
  expect(purchaseAvailability('SKU', 99).buyable).toBe(true);
  stop();
  let complete!: (value: AvailabilityResponse) => void;
  const delayed = vi.fn(
    () =>
      new Promise<AvailabilityResponse>((resolve) => {
        complete = resolve;
      })
  );
  const stale = vi.fn();
  const unmount = loadPageAvailability(['old'], 'products', stale, delayed);
  unmount();
  complete({ products: [{ id: 'old', status: 'sold_out' }] });
  await flush();
  expect(stale).toHaveBeenCalledTimes(1);
});
it('uses all fetched variants without another option request and respects stock/backorders/unknown counts', () => {
  const product: ProductAvailability = {
    id: 'p1',
    status: 'in_stock',
    variants: [
      { sku: 'A', available: 2, continueSelling: false },
      { sku: 'B', available: 0, continueSelling: true },
      { sku: 'C', available: 0, continueSelling: false },
      { sku: 'D', available: null, continueSelling: true },
    ],
  };
  expect(purchaseAvailability('A', 99, product)).toMatchObject({ buyable: true, maxQty: 2 });
  expect(purchaseAvailability('B', 99, product)).toMatchObject({ buyable: true, maxQty: 99 });
  expect(purchaseAvailability('C', 99, product).buyable).toBe(false);
  expect(purchaseAvailability('D', 99, product).buyable).toBe(false);
  expect(purchaseAvailability(undefined, 99).buyable).toBe(false);
  expect(purchaseAvailability('A', 1, product).maxQty).toBe(1);
  expect(purchaseAvailability('A', 99).variant).toBeUndefined();
});

it('deduplicates simultaneous page reads and never refreshes on a successful cart event', async () => {
  let finish!: (value: AvailabilityResponse) => void;
  const read = vi.fn(
    () =>
      new Promise<AvailabilityResponse>((resolve) => {
        finish = resolve;
      })
  );
  const update = vi.fn();
  const events = new EventTarget();
  const stop = loadPageAvailability(['p1'], 'products', update, read);
  const stopSecond = loadPageAvailability(['p1'], 'products', vi.fn(), read);
  events.dispatchEvent(new Event('cart-added'));
  expect(read).toHaveBeenCalledTimes(1);
  finish({ products: [{ id: 'p1', status: 'sold_out' }] });
  await flush();
  expect(read).toHaveBeenCalledTimes(1);
  expect(update.mock.calls.at(-1)?.[0].p1.status).toBe('sold_out');
  stop();
  stopSecond();
});

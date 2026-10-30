import { z } from 'zod';
import { CheckoutError } from './checkout';
import {
  type AvailabilityInput,
  productAvailabilitySchema,
  type AvailabilityMode,
  type ProductAvailability,
} from '../schemas/availability';

const CACHE_SECONDS = 5;
const cacheEntrySchema = z.object({ expiresAt: z.number(), product: productAvailabilitySchema });
// Only outstanding work is retained in memory. The Cache API owns the five-second TTL.
const pendingByDb = new WeakMap<D1Database, Map<string, Promise<ProductAvailability>>>();

type Row = {
  id: string;
  status: string;
  sku: string | null;
  available: number | null;
  continueSelling: number | null;
};
async function readProducts(db: D1Database, ids: string[], mode: AvailabilityMode) {
  const { results } = await db
    .prepare(
      `SELECT p.id,p.status,v.sku,s.on_hand-s.reserved AS available,v.continue_selling AS continueSelling
    FROM products p LEFT JOIN variants v ON v.product_id=p.id AND v.status='active'
    LEFT JOIN stock s ON s.sku=v.sku WHERE p.id IN (${ids.map(() => '?').join(',')})`
    )
    .bind(...ids)
    .all<Row>();
  const rowsById = new Map<string, Row[]>();
  for (const row of results) {
    const rows = rowsById.get(row.id) ?? [];
    rows.push(row);
    rowsById.set(row.id, rows);
  }
  return ids.map((id): ProductAvailability => {
    const rows = rowsById.get(id) ?? [];
    const active = rows[0]?.status === 'active';
    const variants = active
      ? rows
          .filter((r) => r.sku !== null)
          .map((r) => ({
            sku: r.sku!,
            available: r.available === null ? null : Math.max(0, r.available),
            continueSelling: !!r.continueSelling,
          }))
      : [];
    const stocked = variants.some((v) => v.available !== null && v.available > 0);
    const backorder = variants.some((v) => v.available !== null && v.continueSelling);
    const usable = variants.some((v) => v.available !== null);
    return {
      id,
      status:
        !active || !usable
          ? 'unavailable'
          : stocked
            ? 'in_stock'
            : backorder
              ? 'backorder'
              : 'sold_out',
      ...(mode === 'product' ? { variants } : {}),
    };
  });
}

type AvailabilityCache = Pick<Cache, 'match' | 'put'>;
export type AvailabilityCacheStorage = { open(cacheName: string): Promise<AvailabilityCache> };

export async function getAvailability(
  query: AvailabilityInput,
  db: D1Database,
  origin: string,
  storage?: AvailabilityCacheStorage
) {
  try {
    let cache: AvailabilityCache | undefined;
    try {
      cache = await storage?.open('availability-v1');
    } catch {
      console.warn(JSON.stringify({ event: 'availability_cache_open_failed' }));
    }
    const keys = query.ids.map(
      (id) =>
        new Request(`${origin}/_internal/availability/v1/${query.mode}/${encodeURIComponent(id)}`)
    );
    const cached = await Promise.all(
      keys.map(async (key, index) => {
        try {
          const response = await cache?.match(key);
          if (response) {
            const parsed = cacheEntrySchema.safeParse(await response.json());
            if (
              parsed.success &&
              parsed.data.expiresAt > Date.now() &&
              parsed.data.product.id === query.ids[index] &&
              (query.mode !== 'product' || !!parsed.data.product.variants)
            )
              return parsed.data.product;
          }
        } catch {
          console.warn(JSON.stringify({ event: 'availability_cache_read_failed' }));
        }
        return undefined;
      })
    );
    let pending = pendingByDb.get(db);
    if (!pending) {
      pending = new Map();
      pendingByDb.set(db, pending);
    }
    const owners: Array<{
      index: number;
      resolve: (v: ProductAvailability) => void;
      reject: (e: unknown) => void;
    }> = [];
    const promises = query.ids.map((_, index) => {
      if (cached[index]) return Promise.resolve(cached[index]!);
      const key = keys[index]!.url;
      const existing = pending.get(key);
      if (existing) return existing;
      const promise = new Promise<ProductAvailability>((resolve, reject) => {
        owners.push({ index, resolve, reject });
      });
      pending.set(key, promise);
      return promise;
    });
    let population: Promise<void> = Promise.resolve();
    if (owners.length) {
      // Start the batched read after claiming every missing product, allowing overlapping
      // requests to share these promises without reading the whole catalog.
      const populate = async () => {
        try {
          const products = await readProducts(
            db,
            owners.map((o) => query.ids[o.index]!),
            query.mode
          );
          await Promise.all(
            owners.map(async (owner, i) => {
              const product = products[i]!;
              try {
                await cache?.put(
                  keys[owner.index]!,
                  Response.json(
                    { expiresAt: Date.now() + CACHE_SECONDS * 1000, product },
                    { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } }
                  )
                );
              } catch {
                console.warn(JSON.stringify({ event: 'availability_cache_write_failed' }));
              }
              owner.resolve(product);
            })
          );
        } catch (error) {
          for (const owner of owners) owner.reject(error);
        } finally {
          for (const owner of owners) pending.delete(keys[owner.index]!.url);
        }
      };
      // Promise.all below observes the owned promises before a read can reject them.
      population = populate();
    }
    const [products] = await Promise.all([Promise.all(promises), population]);
    return { products };
  } catch (error) {
    console.error(JSON.stringify({ event: 'availability_read_failed', error: String(error) }));
    throw new CheckoutError('Availability temporarily unavailable', 503, 'DEPENDENCY');
  }
}

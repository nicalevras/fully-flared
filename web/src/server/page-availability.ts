import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { AvailabilityById } from '../lib/availability';
import type { AvailabilityMode } from '../schemas/availability';
import { getAvailability } from './availability';

/**
 * Stock for a page loader's own server call, so client navigation needs no second request.
 * SSR passes `live: false`: its loader data is dehydrated into publicly cached HTML.
 * Null means the page reads availability itself.
 */
export async function pageAvailability(
  live: boolean,
  ids: string[],
  mode: AvailabilityMode
): Promise<AvailabilityById | null> {
  if (!live) return null;
  setResponseHeader('Cache-Control', 'no-store');
  const { env } = await import('cloudflare:workers');
  const origin = new URL(getRequest().url).origin;
  const storage = typeof caches === 'undefined' ? undefined : caches;
  const distinct = [...new Set(ids)];
  const batches = [];
  for (let offset = 0; offset < distinct.length; offset += 50)
    batches.push(
      getAvailability({ mode, ids: distinct.slice(offset, offset + 50) }, env.DB, origin, storage)
    );
  try {
    const results = await Promise.all(batches);
    return Object.fromEntries(results.flatMap((r) => r.products).map((p) => [p.id, p]));
  } catch {
    return null;
  }
}

import { getRequest } from '@tanstack/react-start/server';
import { resolveCanonicalBase } from '../lib/seo';

// Request origin for canonical fallback, '' outside a request context.
function requestOrigin(): string {
  try {
    return new URL(getRequest().url).origin;
  } catch {
    return '';
  }
}

// Effective canonical base for this request: configured setting wins,
// otherwise the serving origin. Applied per-request in server functions;
// never baked into the KV layout snapshot, which would pin one host.
export function requestCanonicalBase(configured: string): string {
  return resolveCanonicalBase(configured, requestOrigin());
}

export function withRequestCanonicalBase<T extends { canonicalBaseUrl: string }>(layout: T): T {
  return { ...layout, canonicalBaseUrl: requestCanonicalBase(layout.canonicalBaseUrl) };
}

// Workers Cache policy for public storefront HTML (Phase 4).
//
// The default entrypoint is an uncached gateway: it classifies each
// request, and only ordinary public HTML GETs are forwarded (cookies
// and authorization stripped, tracking parameters removed) to the
// PublicStorefront entrypoint, whose cacheable responses Workers Cache
// may store. Everything else renders directly in the gateway.
// Responses are tagged by affected scope so catalog changes can purge
// exactly the pages they touch; the 60 s TTL is the fallback when a
// purge has not landed yet.

const EXCLUDED_PREFIX =
  /^\/(?:api|_server|_serverFn|admin|auth|account|checkout|cart|ws|search)(?:\/|$)/;
const PUBLIC_PREFIX = /^\/(?:products|collections|pages|blog)(?:\/|$)/;

// Known click-tracking parameters that never change rendered content.
// Anything else (pagination, filters) is preserved in the cache key.
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  '_ga',
]);

/** Returns the cleaned request to forward to PublicStorefront, or
 *  null when the request must render directly in the gateway. */
export function publicCacheRequest(request: Request): Request | null {
  if (request.method !== 'GET') return null;
  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') return null;
  if (!request.headers.get('accept')?.includes('text/html')) return null;
  const url = new URL(request.url);
  if (EXCLUDED_PREFIX.test(url.pathname)) return null;
  if (url.pathname !== '/' && !PUBLIC_PREFIX.test(url.pathname)) return null;
  for (const key of [...url.searchParams.keys()])
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  const headers = new Headers(request.headers);
  // Public rendering must not see private state: the same URL renders
  // identical HTML for anonymous, guest and signed-in shoppers.
  headers.delete('cookie');
  headers.delete('authorization');
  // Forwarding/override headers must not change URL or cache identity.
  headers.delete('forwarded');
  headers.delete('x-forwarded-host');
  headers.delete('x-forwarded-proto');
  headers.delete('x-forwarded-port');
  headers.delete('x-original-url');
  headers.delete('x-rewrite-url');
  return new Request(url, { method: 'GET', headers });
}

const PRIVATE_PREFIX = /^\/(?:api|_server|_serverFn|admin|auth|account|checkout|cart|ws)(?:\/|$)/;

/** True when a response must never be shared: the request carried
 *  private state, the response sets cookies, or the path is private. */
export function privateResponse(request: Request, response: Response): boolean {
  return (
    request.headers.has('cookie') ||
    request.headers.has('authorization') ||
    response.headers.has('set-cookie') ||
    PRIVATE_PREFIX.test(new URL(request.url).pathname)
  );
}

/** Cache tags for a public path. Every page carries `layout`; scopes
 *  mirror the publisher's invalidation vocabulary so a purge by scope
 *  hits exactly the pages that scope can change. */
export function cacheTagsForPath(pathname: string): string[] {
  const tags = ['layout'];
  if (pathname === '/') {
    tags.push('listing-all');
    return tags;
  }
  const [, section, slug] = pathname.split('/');
  if (section === 'products' && slug) tags.push(`product-${slug}`);
  else if (section === 'collections' && slug) tags.push(`listing-${slug}`);
  else if (section === 'pages' && slug) tags.push(`editorial-${slug}`);
  else if (section === 'blog') tags.push(slug ? `editorial-${slug}` : 'editorial-index');
  return tags;
}

/** Applies the Workers Cache storage policy to a rendered response.
 *  Only successful HTML without private state is storable, for a
 *  60-second shared TTL with browser revalidation; anything else is
 *  marked uncacheable so it can never be stored or replayed. */
export function publicCacheResponse(response: Response, tags: string[]): Response {
  const cacheable =
    response.status === 200 &&
    (response.headers.get('content-type') ?? '').includes('text/html') &&
    !response.headers.has('set-cookie') &&
    !(response.headers.get('cache-control') ?? '').includes('no-store');
  if (cacheable) {
    response.headers.set('Cache-Control', 'public, max-age=0, s-maxage=60');
    // Some route loaders set their own longer CDN TTLs from the
    // pre-Workers-Cache design; the entrypoint policy wins so purges
    // and the 60 s bound hold for every public page.
    response.headers.set('CDN-Cache-Control', 'max-age=60');
    response.headers.set('Cache-Tag', tags.join(','));
  } else if (!(response.headers.get('cache-control') ?? '').includes('no-store')) {
    response.headers.set('Cache-Control', 'private, no-store');
  }
  return response;
}

export type CatalogInvalidation = { id: string; scope: string; scopeId: string };

export function invalidationTag(scope: string, scopeId: string): string | null {
  switch (scope) {
    case 'layout':
      return 'layout';
    case 'product':
      return scopeId ? `product-${scopeId}` : null;
    case 'listing':
      return scopeId ? `listing-${scopeId}` : null;
    case 'editorial':
      return scopeId ? `editorial-${scopeId}` : null;
    default:
      return null;
  }
}

export function invalidationTags(rows: CatalogInvalidation[]): string[] {
  const tags = new Set<string>();
  for (const row of rows) {
    const tag = invalidationTag(row.scope, row.scopeId);
    if (tag) tags.add(tag);
  }
  return [...tags];
}

/** Drains pending catalog invalidations through the cache-owning
 *  entrypoint. Rows are deleted only after a successful purge; on
 *  failure they stay pending for the next pass and the TTL remains
 *  the fallback, so a failed purge never loses the invalidation. */
export async function drainCatalogInvalidations(
  db: D1Database,
  purge: (tags: string[]) => Promise<unknown>,
  limit = 500
): Promise<{ drained: number; tags: string[] }> {
  const rows = await db
    .prepare(
      'SELECT id, scope, scope_id AS scopeId FROM catalog_invalidations ORDER BY created_at ASC LIMIT ?'
    )
    .bind(limit)
    .all<CatalogInvalidation>();
  if (!rows.results.length) return { drained: 0, tags: [] };
  // Only rows that map to a real tag may be deleted, and only after
  // that tag was purged. Unmappable rows stay pending and visible in
  // logs instead of being silently dropped with the mapped ones.
  const mapped = rows.results.filter((r) => invalidationTag(r.scope, r.scopeId) !== null);
  const unmappable = rows.results.length - mapped.length;
  if (unmappable > 0)
    console.error(
      JSON.stringify({
        event: 'catalog_invalidation_unmappable',
        count: unmappable,
        ids: rows.results
          .filter((r) => invalidationTag(r.scope, r.scopeId) === null)
          .map((r) => r.id),
      })
    );
  const tags = invalidationTags(mapped);
  if (tags.length) {
    try {
      await purge(tags);
    } catch (error) {
      console.error(JSON.stringify({ event: 'catalog_cache_purge_failed', error: String(error) }));
      return { drained: 0, tags };
    }
  }
  const ids = mapped.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    await db
      .prepare(`DELETE FROM catalog_invalidations WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .run();
  }
  return { drained: mapped.length, tags };
}

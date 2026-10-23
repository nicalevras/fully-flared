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
  const paginated =
    url.pathname === '/' ||
    url.pathname === '/collections' ||
    /^\/collections\/[^/]+\/?$/.test(url.pathname) ||
    url.pathname === '/blog';
  for (const key of [...url.searchParams.keys()])
    if (TRACKING_PARAMS.has(key.toLowerCase()) || !(paginated && key === 'page'))
      url.searchParams.delete(key);
  if (paginated && url.searchParams.has('page')) {
    const page = Number(url.searchParams.get('page'));
    url.searchParams.set(
      'page',
      String(Number.isSafeInteger(page) && page >= 1 && page <= 100_000 ? page : 1)
    );
  }
  url.searchParams.sort();
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
    tags.push('listing-all', 'listing-@collections');
    return tags;
  }
  const [, section, slug] = pathname.split('/');
  if (section === 'products' && slug) tags.push(`product-${slug}`);
  else if (section === 'collections') tags.push(slug ? `listing-${slug}` : 'listing-@collections');
  else if (section === 'pages' && slug) tags.push(`editorial-${slug}`);
  else if (section === 'blog')
    tags.push(...(slug ? [`editorial-${slug}`] : ['editorial-index', 'listing-@posts']));
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

// Workers Cache purges always run under the Free plan limits: 5 requests
// per minute refilling a bucket of 25, at most 100 tags per request.
const PURGE_BUCKET = 25;
const PURGE_REFILL_PER_MS = 5 / 60_000;
const PURGE_TAG_LIMIT = 100;

/** Takes one purge request from the durable bucket shared by every
 *  drain. A single conditional UPDATE refills and spends atomically,
 *  so concurrent drains can never overspend the account limit. */
export async function takePurgeToken(db: D1Database, nowMs = Date.now()): Promise<boolean> {
  const available = `MIN(${PURGE_BUCKET},tokens+MAX(0,?1-refilled_at)*${PURGE_REFILL_PER_MS})`;
  const taken = await db
    .prepare(
      `UPDATE cache_purge_gate SET tokens=${available}-1,refilled_at=MAX(refilled_at,?1) WHERE id=1 AND ${available}>=1 RETURNING tokens`
    )
    .bind(nowMs)
    .first();
  return taken !== null;
}

/** Drains pending catalog invalidations through the cache-owning
 *  entrypoint, at most 100 tags per purge and one gate token per
 *  request. Rows are deleted only once their tag was purged; a refused
 *  or failed request leaves the rest pending for the next pass and the
 *  TTL remains the fallback, so a failed purge never loses one. */
export async function drainCatalogInvalidations(
  db: D1Database,
  purge: (tags: string[]) => Promise<unknown>,
  limit = 500
): Promise<{ drained: number; tags: string[] }> {
  const rows = await db
    .prepare(
      `SELECT id, scope, scope_id AS scopeId,ref_key,ref_seq FROM catalog_invalidations i WHERE ref_key IS NULL OR EXISTS(SELECT 1 FROM catalog_ref_state r WHERE r.ref_key=i.ref_key AND r.delivered_seq>=i.ref_seq) ORDER BY created_at ASC LIMIT ?`
    )
    .bind(limit)
    .all<CatalogInvalidation & { ref_key: string | null; ref_seq: number | null }>();
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
  const purged = new Set<string>();
  for (let i = 0; i < tags.length; i += PURGE_TAG_LIMIT) {
    const chunk = tags.slice(i, i + PURGE_TAG_LIMIT);
    if (!(await takePurgeToken(db))) {
      console.warn(
        JSON.stringify({ event: 'catalog_cache_purge_deferred', pending: tags.length - i })
      );
      break;
    }
    try {
      await purge(chunk);
    } catch (error) {
      console.error(JSON.stringify({ event: 'catalog_cache_purge_failed', error: String(error) }));
      break;
    }
    for (const tag of chunk) purged.add(tag);
  }
  const done = mapped.filter((r) => purged.has(invalidationTag(r.scope, r.scopeId) ?? ''));
  let drained = 0;
  for (let i = 0; i < done.length; i += 90) {
    const chunk = done.slice(i, i + 90);
    const removed = await db
      .prepare(
        `DELETE FROM catalog_invalidations WHERE EXISTS(SELECT 1 FROM json_each(?) x
        WHERE json_extract(x.value,'$.id')=catalog_invalidations.id
          AND json_extract(x.value,'$.ref_key') IS catalog_invalidations.ref_key
          AND json_extract(x.value,'$.ref_seq') IS catalog_invalidations.ref_seq)
        AND (ref_key IS NULL OR EXISTS(SELECT 1 FROM catalog_ref_state r WHERE r.ref_key=catalog_invalidations.ref_key AND r.delivered_seq>=catalog_invalidations.ref_seq))`
      )
      .bind(JSON.stringify(chunk.map(({ id, ref_key, ref_seq }) => ({ id, ref_key, ref_seq }))))
      .run();
    drained += removed.meta.changes ?? 0;
  }
  return { drained, tags: [...purged] };
}

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

const EXCLUDED_PREFIX = /^\/(?:api|_server|_serverFn|admin|auth|account|checkout|cart|ws)(?:\/|$)/;
const PUBLIC_PREFIX = /^\/(?:products|collections|pages|articles|shop|search)(?:\/|$)/;
const SITEMAP_PATH = /^\/sitemap(?:\.xml|\/[a-z]+\.xml)$/;

export const isSitemapPath = (pathname: string) => SITEMAP_PATH.test(pathname);
const RSS_PATH = '/articles/rss.xml';
const XML_TYPES = ['application/xml', 'text/xml'];

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

const PAGE_PARAMS = ['page'];
const SEARCH_PARAMS = ['q', 'cursor'];
const SITEMAP_PARAMS = ['from'];

/** Returns the cleaned request to forward to PublicStorefront, or
 *  null when the request must render directly in the gateway. */
export function publicCacheRequest(request: Request): Request | null {
  if (request.method !== 'GET') return null;
  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') return null;
  // Crawlers and bare HTTP clients often send no Accept or */*; they get the same HTML.
  const url = new URL(request.url);
  const sitemap = isSitemapPath(url.pathname);
  const accept = request.headers.get('accept');
  const accepted = [
    'text/html',
    '*/*',
    ...(sitemap ? XML_TYPES : []),
    ...(url.pathname === RSS_PATH ? ['application/rss+xml', ...XML_TYPES] : []),
  ];
  if (accept && !accepted.some((type) => accept.includes(type))) return null;
  if (EXCLUDED_PREFIX.test(url.pathname)) return null;
  if (url.pathname !== '/' && !sitemap && !PUBLIC_PREFIX.test(url.pathname)) return null;
  const paginated =
    url.pathname === '/shop' ||
    url.pathname === '/collections' ||
    /^\/collections\/[^/]+\/?$/.test(url.pathname) ||
    url.pathname === '/articles';
  const kept =
    url.pathname === '/search'
      ? SEARCH_PARAMS
      : paginated
        ? PAGE_PARAMS
        : sitemap
          ? SITEMAP_PARAMS
          : [];
  for (const key of [...url.searchParams.keys()])
    if (TRACKING_PARAMS.has(key.toLowerCase()) || !kept.includes(key)) url.searchParams.delete(key);
  // Page 1 renders at the bare path, so it shares that cache entry.
  if (url.searchParams.has('page')) {
    const page = Number(url.searchParams.get('page'));
    if (Number.isSafeInteger(page) && page > 1 && page <= 100_000)
      url.searchParams.set('page', String(page));
    else url.searchParams.delete('page');
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
 *  private state, the response sets cookies, or the path is private.
 *  /media/ bytes are identical for every visitor, so its request
 *  credentials do not make the response private. */
export function privateResponse(request: Request, response: Response): boolean {
  if (response.headers.has('set-cookie')) return true;
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith('/media/')) return false;
  return (
    request.headers.has('cookie') ||
    request.headers.has('authorization') ||
    PRIVATE_PREFIX.test(pathname)
  );
}

/** Cache tags for a public path. Every page carries `layout`; scopes
 *  mirror the publisher's invalidation vocabulary so a purge by scope
 *  hits exactly the pages that scope can change. */
export function cacheTagsForPath(pathname: string): string[] {
  const tags = ['layout'];
  if (pathname === '/') {
    tags.push('listing-@featured', 'listing-@collections');
    return tags;
  }
  if (pathname === RSS_PATH) {
    tags.push('editorial-index', 'listing-@posts');
    return tags;
  }
  const [, section, slug] = pathname.split('/');
  if (section === 'shop' || section === 'search') tags.push('listing-all');
  else if (section === 'products' && slug) tags.push(`product-${slug}`);
  else if (section === 'collections') tags.push(slug ? `listing-${slug}` : 'listing-@collections');
  else if (section === 'pages' && slug) tags.push(`editorial-${slug}`);
  else if (section === 'articles')
    tags.push(...(slug ? [`editorial-${slug}`] : ['editorial-index', 'listing-@posts']));
  return tags;
}

/** Applies the Workers Cache storage policy to a rendered response.
 *  Only HTML and the RSS feed without private state are storable: a page for a 60-second
 *  shared TTL with browser revalidation, a not-found page for 30 seconds
 *  so unknown slugs stop reaching storage; anything else is marked
 *  uncacheable so it can never be stored or replayed. */
export function publicCacheResponse(response: Response, tags: string[]): Response {
  const ttl = response.status === 200 ? 60 : response.status === 404 ? 30 : 0;
  const cacheable =
    ttl > 0 &&
    /^(?:text\/html|application\/rss\+xml)\b/.test(response.headers.get('content-type') ?? '') &&
    !response.headers.has('set-cookie') &&
    !(response.headers.get('cache-control') ?? '').includes('no-store');
  if (cacheable) {
    response.headers.set('Cache-Control', `public, max-age=0, s-maxage=${ttl}`);
    response.headers.set('CDN-Cache-Control', `max-age=${ttl}`);
    response.headers.set('Cache-Tag', tags.join(','));
  } else if (!(response.headers.get('cache-control') ?? '').includes('no-store')) {
    response.headers.set('Cache-Control', 'private, no-store');
  }
  return response;
}

/** Sitemaps change only when the catalogue does and carry no cache tag,
 *  so they are shared for an hour by browsers and a day at the edge. */
export function sitemapCacheResponse(response: Response): Response {
  const cacheable =
    response.status === 200 &&
    (response.headers.get('content-type') ?? '').includes('xml') &&
    !response.headers.has('set-cookie');
  if (cacheable) {
    response.headers.set('Cache-Control', 'public, max-age=3600');
    response.headers.set('CDN-Cache-Control', 'max-age=86400');
  } else {
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
 *  entrypoint, one purge per distinct tag however many rows share it,
 *  at most 100 tags per purge and one gate token per request. A purged
 *  tag deletes only rows that were already safe to drop when the pass
 *  began; anything newer, undelivered or refused stays for a later
 *  pass and the TTL remains the fallback, so a purge is never lost. */
export async function drainCatalogInvalidations(
  db: D1Database,
  purge: (tags: string[]) => Promise<unknown>,
  limit = 500
): Promise<{ drained: number; tags: string[]; more: boolean }> {
  const startedAt = new Date().toISOString();
  const mark =
    (
      await db
        .prepare('SELECT MAX(rowid) AS mark FROM catalog_invalidations')
        .first<{ mark: number | null }>()
    )?.mark ?? 0;
  const groups = await db
    .prepare(
      `SELECT scope, scope_id AS scopeId FROM catalog_invalidations i WHERE ref_key IS NULL OR EXISTS(SELECT 1 FROM catalog_ref_state r WHERE r.ref_key=i.ref_key AND r.delivered_seq>=i.ref_seq) GROUP BY scope, scope_id ORDER BY MIN(created_at), MIN(rowid) LIMIT ?`
    )
    .bind(limit)
    .all<{ scope: string; scopeId: string }>();
  const mapped = groups.results.flatMap((group) => {
    const tag = invalidationTag(group.scope, group.scopeId);
    return tag ? [{ ...group, tag }] : [];
  });
  // Unmappable rows stay pending and visible in logs instead of being
  // silently dropped with the mapped ones.
  if (mapped.length < groups.results.length)
    console.error(
      JSON.stringify({
        event: 'catalog_invalidation_unmappable',
        scopes: groups.results
          .filter((group) => invalidationTag(group.scope, group.scopeId) === null)
          .map((group) => `${group.scope}:${group.scopeId}`),
      })
    );
  const purged: string[] = [];
  let drained = 0;
  for (let i = 0; i < mapped.length; i += PURGE_TAG_LIMIT) {
    const chunk = mapped.slice(i, i + PURGE_TAG_LIMIT);
    const tags = [...new Set(chunk.map((group) => group.tag))];
    if (!(await takePurgeToken(db))) {
      console.warn(
        JSON.stringify({ event: 'catalog_cache_purge_deferred', pending: mapped.length - i })
      );
      return { drained, tags: purged, more: false };
    }
    try {
      await purge(tags);
    } catch (error) {
      console.error(JSON.stringify({ event: 'catalog_cache_purge_failed', error: String(error) }));
      return { drained, tags: purged, more: false };
    }
    purged.push(...tags);
    // last_write_at only moves forward on delivery, so a ref delivered
    // after the pass began keeps its rows; NULL means it was confirmed
    // without a KV write. The rowid mark keeps rows inserted during the
    // pass even when the database clock is behind the Worker clock.
    const removed = await db
      .prepare(
        `DELETE FROM catalog_invalidations WHERE (scope,scope_id) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?1)) AND rowid<=?3
        AND ((ref_key IS NULL AND created_at<=?2) OR EXISTS(SELECT 1 FROM catalog_ref_state r WHERE r.ref_key=catalog_invalidations.ref_key AND r.delivered_seq>=catalog_invalidations.ref_seq AND COALESCE(r.last_write_at,'')<=?2))`
      )
      .bind(JSON.stringify(chunk.map((group) => [group.scope, group.scopeId])), startedAt, mark)
      .run();
    drained += removed.meta.changes ?? 0;
  }
  return { drained, tags: purged, more: groups.results.length === limit };
}

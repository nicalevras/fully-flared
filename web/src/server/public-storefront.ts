import { WorkerEntrypoint } from 'cloudflare:workers';
import entry from '@tanstack/react-start/server-entry';
import { runWithRequestContext } from './exec-context';
import {
  cacheTagsForPath,
  isSitemapPath,
  publicCacheResponse,
  sitemapCacheResponse,
} from './public-cache';

/** Cache-owning entrypoint for public storefront HTML (Phase 4).
 *  Workers Cache sits in front of this entrypoint's fetch; the
 *  default gateway entrypoint is uncached and forwards only
 *  classified public requests here, with private headers stripped.
 *  Programmatic purges are scoped to the entrypoint that owns the
 *  cached responses, so invalidation must run inside this class. */
export class PublicStorefront extends WorkerEntrypoint<Cloudflare.Env, { store: string }> {
  override async fetch(request: Request): Promise<Response> {
    const response = await runWithRequestContext(this.ctx, () => entry.fetch(request));
    const { pathname } = new URL(request.url);
    if (isSitemapPath(pathname)) return sitemapCacheResponse(response);
    return publicCacheResponse(response, cacheTagsForPath(pathname));
  }

  /** Purges this entrypoint's cached responses for the given tags.
   *  Throws when the cache API is unavailable so the caller keeps the
   *  invalidation rows pending instead of losing them silently. */
  async purgeInvalidations(tags: string[]): Promise<void> {
    if (!tags.length) return;
    if (!this.ctx.cache) throw new Error('Workers Cache API unavailable');
    const result = await this.ctx.cache.purge({ tags });
    if (!result.success) {
      console.error(
        JSON.stringify({
          event: 'public_cache_purge_rejected',
          codes: result.errors?.map((error) => error.code),
        })
      );
      throw new Error('Public cache purge was rejected');
    }
  }
}

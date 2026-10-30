import { normalizeNetwork } from './network';

type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

/** Per-network budget for storefront reads that reach D1 past the edge
 *  cache: product slugs missing from KV, searches with terms, and checkout
 *  quotes and cart writes. Keyed on the IPv6 /64 or IPv4 address, the only identity a
 *  cookie-free public request has. Fails open: a missing or failing binding never
 *  turns shoppers away. */
export async function storefrontLimited(
  limiter: Limiter | undefined,
  kind: 'product' | 'search' | 'quote' | 'cart',
  request: Request
): Promise<boolean> {
  if (!limiter) return false;
  const network = normalizeNetwork(request.headers.get('CF-Connecting-IP') ?? 'unknown');
  try {
    return !(await limiter.limit({ key: `${kind}:${network}` })).success;
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'storefront_limiter_unavailable', kind, error: String(error) })
    );
    return false;
  }
}

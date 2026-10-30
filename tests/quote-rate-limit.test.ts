import { describe, expect, it } from 'vitest';
import { quoteLimitError } from '../web/src/lib/shopFns';

function fakeLimiter(limit: number) {
  const counts = new Map<string, number>();
  return {
    limit: async ({ key }: { key: string }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}

const from = (ip: string) =>
  new Request('https://shop.test/_serverFn/quote', { headers: { 'CF-Connecting-IP': ip } });

describe('checkout quote rate limit (MS-14)', () => {
  it('31st quote in a minute is limited', async () => {
    const env = { STOREFRONT_LIMITER: fakeLimiter(30), AUTH_LIMITER: fakeLimiter(20) };
    for (let i = 1; i <= 30; i++) {
      expect(await quoteLimitError(env, from('203.0.113.9'), undefined)).toBeNull();
    }
    expect(await quoteLimitError(env, from('203.0.113.9'), undefined)).toBe(
      'Too many checkout requests'
    );
    expect(await quoteLimitError(env, from('203.0.113.10'), undefined)).toBeNull();
  });

  it('a discount code also spends the discount-guess budget', async () => {
    const env = { STOREFRONT_LIMITER: fakeLimiter(30), AUTH_LIMITER: fakeLimiter(1) };
    expect(await quoteLimitError(env, from('203.0.113.9'), 'SAVE10')).toBeNull();
    expect(await quoteLimitError(env, from('203.0.113.9'), 'SAVE10')).toBe(
      'Too many discount attempts'
    );
  });
});

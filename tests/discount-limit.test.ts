import { describe, expect, it } from 'vitest';
import { discountAttemptLimited } from '../web/src/lib/shopFns';

// P0 item 5: discount-code guessing must be rate limited inside the server
// function (server functions bypass the server.ts path matcher, and the
// old /api/discount/validate branch matched a deleted route). The handler
// calls discountAttemptLimited before calculateDiscount, so the 21st
// attempt from one identity never reaches code validation.
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

describe('discount validation rate limit', () => {
  it('the 21st attempt from one identity is limited', async () => {
    const env = { AUTH_LIMITER: fakeLimiter(20) };
    for (let i = 1; i <= 20; i++) {
      expect(await discountAttemptLimited(env, 'brute@example.com:1.2.3.4')).toBe(false);
    }
    expect(await discountAttemptLimited(env, 'brute@example.com:1.2.3.4')).toBe(true);
  });

  it('a different identity keeps its own budget', async () => {
    const env = { AUTH_LIMITER: fakeLimiter(1) };
    expect(await discountAttemptLimited(env, 'a@example.com:1.2.3.4')).toBe(false);
    expect(await discountAttemptLimited(env, 'a@example.com:1.2.3.4')).toBe(true);
    expect(await discountAttemptLimited(env, 'b@example.com:1.2.3.4')).toBe(false);
  });

  it('a missing limiter fails closed', async () => {
    expect(await discountAttemptLimited({}, 'a@example.com:1.2.3.4')).toBe(true);
  });
});

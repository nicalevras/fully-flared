import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from '../web/src/server/turnstile';

const check = {
  expectedAction: 'checkout',
  expectedHostname: 'shop.example',
  remoteIp: '203.0.113.1',
};

function env(secret?: string) {
  return { TURNSTILE_SECRET_KEY: secret } as unknown as Cloudflare.Env;
}

afterEach(() => vi.unstubAllGlobals());

describe('Turnstile siteverify', () => {
  it('is a no-op only when no secret is configured', async () => {
    await expect(verifyTurnstile(env(), undefined, check)).resolves.toBe(true);
  });

  it('fails closed for missing tokens and siteverify errors', async () => {
    await expect(verifyTurnstile(env('secret'), undefined, check)).resolves.toBe(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    await expect(verifyTurnstile(env('secret'), 'token', check)).resolves.toBe(false);
  });

  it('requires success plus the exact action and hostname', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, action: 'checkout', hostname: 'shop.example' })
        )
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(verifyTurnstile(env('secret'), 'token', check)).resolves.toBe(true);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(String(init.body)).toContain('secret=secret');
    expect(String(init.body)).toContain('response=token');

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, action: 'login', hostname: 'shop.example' }))
      )
    );
    await expect(verifyTurnstile(env('secret'), 'token', check)).resolves.toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ success: true, action: 'checkout', hostname: 'evil.example' })
          )
      )
    );
    await expect(verifyTurnstile(env('secret'), 'token', check)).resolves.toBe(false);
  });
});

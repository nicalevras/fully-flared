import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from '../web/src/server/turnstile';
import type { WorkerEnv } from '../web/src/server/env';
import { createTestDb } from './helpers/d1';
import { at, present } from './helpers/fixtures';

const check = {
  expectedAction: 'checkout',
  expectedHostname: 'shop.example',
  remoteIp: '203.0.113.1',
};

let bindings: Env, dispose: () => Promise<void>;
beforeAll(async () => {
  ({ env: bindings, dispose } = await createTestDb());
});
afterAll(async () => {
  await dispose();
});

function env(secret?: string): WorkerEnv {
  return secret === undefined ? bindings : { ...bindings, TURNSTILE_SECRET_KEY: secret };
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
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ success: true, action: 'checkout', hostname: 'shop.example' })
        )
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(verifyTurnstile(env('secret'), 'token', check)).resolves.toBe(true);
    const init = present(at(fetchMock.mock.calls, 0)[1], 'the siteverify request');
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

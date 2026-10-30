import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';
import { createAuth } from '../web/src/lib/auth';

const base = 'https://shop.example';
const siteverify = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const emailEndpoints = [
  ['/sign-up/email', { name: 'Bot', email: 'bot@example.invalid', password: 'password123' }],
  ['/sign-in/email', { email: 'bot@example.invalid', password: 'password123' }],
  ['/request-password-reset', { email: 'bot@example.invalid', redirectTo: '/' }],
  ['/sign-in/magic-link', { email: 'bot@example.invalid' }],
  ['/send-verification-email', { email: 'bot@example.invalid' }],
] as const;

let db: D1Database;
let dispose: () => Promise<void>;
let auth: ReturnType<typeof createAuth>;
let ip = 0;

function post(path: string, body: object, token?: string): Promise<Response> {
  ip += 1;
  return auth.handler(
    new Request(`${base}/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        'cf-connecting-ip': `198.51.100.${ip}`,
        ...(token ? { 'x-captcha-response': token } : {}),
      },
      body: JSON.stringify(body),
    })
  );
}

function siteverifyReturns(result: { success: boolean; hostname?: string; action?: string }) {
  const passthrough = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === siteverify
        ? Promise.resolve(Response.json(result))
        : passthrough(input, init)
    )
  );
}

beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  auth = createAuth(
    db,
    base,
    'captcha-regression-secret-at-least-32-characters',
    [],
    'turnstile-secret',
    'Test Store'
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => dispose());

describe('Turnstile on every email-sending auth endpoint (MS-3)', () => {
  it.each(emailEndpoints)('%s without x-captcha-response is 400', async (path, body) => {
    expect((await post(path, body)).status).toBe(400);
  });
});

describe('Turnstile pins hostname and action (MS-17)', () => {
  const signIn = { email: 'nobody@example.invalid', password: 'password123' };

  it('token for another hostname is rejected', async () => {
    siteverifyReturns({ success: true, hostname: 'evil.example', action: 'auth' });
    expect((await post('/sign-in/email', signIn, 'token')).status).toBe(403);
  });

  it('token minted for another action is rejected', async () => {
    siteverifyReturns({ success: true, hostname: 'shop.example', action: 'checkout' });
    expect((await post('/sign-in/email', signIn, 'token')).status).toBe(403);
  });

  it('token for this store and the auth action passes the captcha', async () => {
    siteverifyReturns({ success: true, hostname: 'shop.example', action: 'auth' });
    expect((await post('/sign-in/email', signIn, 'token')).status).toBe(401);
  });
});

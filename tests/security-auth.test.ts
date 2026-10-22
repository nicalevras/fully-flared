import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { createAuth, hashSessionToken } from '../web/src/lib/auth';
import { ACTION_PERMISSIONS, roles } from '../web/src/lib/permissions';
import { resolveAuthBaseUrl } from '../web/src/server/session';

let db: D1Database;
let dispose: () => Promise<void>;
let auth: ReturnType<typeof createAuth>;

function base32ToBytes(secret: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) continue;
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(bytes);
}

async function totp(secret: string, offsetSteps = 0): Promise<string> {
  const counter = Math.floor(Date.now() / 30_000) + offsetSteps;
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(4, counter);
  const key = await crypto.subtle.importKey(
    'raw',
    base32ToBytes(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, message as BufferSource));
  const offset = signature[signature.length - 1]! & 0x0f;
  const code =
    ((signature[offset]! & 0x7f) << 24) |
    ((signature[offset + 1]! & 0xff) << 16) |
    ((signature[offset + 2]! & 0xff) << 8) |
    (signature[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

function cookieHeader(response: Response): string {
  const raw = response.headers.get('set-cookie') ?? '';
  return raw
    .split(/,(?=\s*[^;,=]+?=)/)
    .map((part) => part.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');
}

async function post(path: string, body: unknown, cookie = ''): Promise<Response> {
  return auth.handler(
    new Request(`http://localhost:8799/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:8799',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    })
  );
}

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  auth = createAuth(
    db,
    'http://localhost:8799',
    'test-secret-that-is-long-enough',
    [],
    undefined,
    'Test Store'
  );
});
afterAll(async () => {
  await dispose();
});

describe('auth base URL resolution (admin must load locally)', () => {
  const req = (url: string) => new Request(url);

  it('uses a valid configured URL and normalizes it to the origin', () => {
    expect(
      resolveAuthBaseUrl('https://shop.example.com/', req('http://localhost:8799/admin'))
    ).toBe('https://shop.example.com');
    expect(resolveAuthBaseUrl('http://localhost:8799', req('http://localhost:8799/admin'))).toBe(
      'http://localhost:8799'
    );
  });

  it('falls back to the loopback origin when the wrangler placeholder is still set', () => {
    // Regression: REPLACE_WITH_STORE_URL reached Better Auth verbatim and
    // every /admin navigation died with "Invalid base URL".
    expect(resolveAuthBaseUrl('REPLACE_WITH_STORE_URL', req('http://localhost:8799/admin'))).toBe(
      'http://localhost:8799'
    );
    expect(resolveAuthBaseUrl(undefined, req('http://127.0.0.1:8799/admin'))).toBe(
      'http://127.0.0.1:8799'
    );
    expect(resolveAuthBaseUrl('not a url', req('http://[::1]:8799/admin'))).toBe(
      'http://[::1]:8799'
    );
  });

  it('still fails closed on non-loopback hosts with a placeholder (no Host trust)', () => {
    expect(() =>
      resolveAuthBaseUrl('REPLACE_WITH_STORE_URL', req('https://shop.example.com/admin'))
    ).toThrow(/BETTER_AUTH_URL is not configured/);
    expect(() => resolveAuthBaseUrl(undefined, req('https://evil.example.com/admin'))).toThrow(
      /BETTER_AUTH_URL is not configured/
    );
  });
});

describe('Better Auth permission matrix', () => {
  it('checks every role through userHasPermission semantics', async () => {
    const cases: [string, string, boolean][] = [
      ['support', 'order.refund', false],
      ['support', 'order.ship', true],
      ['manager', 'order.refund', false],
      ['manager', 'product.create', true],
      ['warehouse', 'stock.adjust', true],
      ['warehouse', 'settings.set', false],
      ['owner', 'order.refund', true],
      ['owner', 'user.setRole', true],
      ['customer', 'product.create', false],
    ];
    for (const [role, action, expected] of cases) {
      const permission = ACTION_PERMISSIONS[action]!;
      const result = await auth.api.userHasPermission({
        body: { role, permissions: { [permission.resource]: [permission.action] } },
      });
      expect(result.success, `${role} -> ${action}`).toBe(expected);
      const local = roles[role as keyof typeof roles].authorize({
        [permission.resource]: [permission.action],
      });
      expect(local.success, `local ${role} -> ${action}`).toBe(expected);
    }
  });

  it('staff magic-link sign-in is refused before a link is issued', async () => {
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
       VALUES ('staff-1', 'Staff', 'staff@example.com', 1, 'support', ?, ?)`
      )
      .bind(now, now)
      .run();
    await expect(
      auth.api.signInMagicLink({ body: { email: 'staff@example.com', callbackURL: '/account' } })
    ).rejects.toMatchObject({ status: 'FORBIDDEN' });
    const outbox = await db
      .prepare("SELECT COUNT(*) AS c FROM outbox WHERE type = 'email.send'")
      .first<{ c: number }>();
    expect(outbox?.c).toBe(0);
  });
});

describe('session-level two-factor marker', () => {
  it('password + TOTP creates a session with a stored 2FA-passed marker', async () => {
    const signup = await post('/sign-up/email', {
      name: 'Owner',
      email: 'owner2@example.com',
      password: 'password123',
    });
    expect(signup.status).toBe(200);
    await db
      .prepare(
        "UPDATE user SET email_verified = 1, role = 'owner' WHERE email = 'owner2@example.com'"
      )
      .run();

    const signin = await post('/sign-in/email', {
      email: 'owner2@example.com',
      password: 'password123',
    });
    expect(signin.status).toBe(200);
    const cookie1 = cookieHeader(signin);
    const enable = await post('/two-factor/enable', { password: 'password123' }, cookie1);
    expect(enable.status).toBe(200);
    const enableBody = (await enable.json()) as { totpURI: string };
    const secret = new URL(enableBody.totpURI).searchParams.get('secret');
    if (!secret) throw new Error('missing TOTP secret');

    // Enabling creates an unverified TOTP record; the setup code must be
    // verified in the current session before sign-in starts challenging.
    let setup: Response | undefined;
    for (const offset of [-1, 0, 1]) {
      setup = await post(
        '/two-factor/verify-totp',
        { code: await totp(secret, offset), trustDevice: false },
        cookie1
      );
      if (setup.status === 200) break;
    }
    expect(setup?.status).toBe(200);
    const enabled = await db
      .prepare('SELECT two_factor_enabled FROM user WHERE email = ?')
      .bind('owner2@example.com')
      .first<{ two_factor_enabled: number }>();
    expect(enabled?.two_factor_enabled).toBe(1);

    const signin2 = await post('/sign-in/email', {
      email: 'owner2@example.com',
      password: 'password123',
    });
    const body2 = (await signin2.clone().json()) as { twoFactorRedirect?: boolean };
    expect(body2.twoFactorRedirect).toBe(true);
    const challengeCookie = cookieHeader(signin2);

    let verify: Response | undefined;
    for (const offset of [-1, 0, 1]) {
      verify = await post(
        '/two-factor/verify-totp',
        { code: await totp(secret, offset), trustDevice: false },
        challengeCookie
      );
      if (verify.status === 200) break;
    }
    expect(verify?.status).toBe(200);
    const verifyBody = (await verify!.clone().json()) as { token: string };
    const hash = await hashSessionToken(verifyBody.token);
    const marker = await db
      .prepare('SELECT user_id FROM staff_two_factor_sessions WHERE session_token_hash = ?')
      .bind(hash)
      .first();
    expect(marker).not.toBeNull();
  });
});

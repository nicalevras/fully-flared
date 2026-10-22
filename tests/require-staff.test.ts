import { afterAll, beforeAll, expect, it } from 'vitest';
import { env } from './helpers/cloudflare-workers-stub';
import { createTestDb } from './helpers/d1';
import { createAuth, hashSessionToken } from '../web/src/lib/auth';
import { requireStaff } from '../web/src/server/session';

let db: D1Database;
let dispose: () => Promise<void>;
let auth: ReturnType<typeof createAuth>;

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
async function signIn(email: string): Promise<string> {
  await post('/sign-up/email', { email, password: 'password123', name: email });
  await db.prepare('UPDATE user SET email_verified = 1 WHERE email = ?').bind(email).run();
  const signin = await post('/sign-in/email', { email, password: 'password123' });
  return cookieHeader(signin);
}
const request = (cookie = '') =>
  new Request('http://localhost:8799/admin', cookie ? { headers: { cookie } } : {});

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  env.BETTER_AUTH_SECRET = 'test-secret-that-is-long-enough-for-tests-0123456789';
  env.BETTER_AUTH_URL = 'http://localhost:8799';
  auth = createAuth(
    db,
    'http://localhost:8799',
    'test-secret-that-is-long-enough-for-tests-0123456789',
    [],
    undefined,
    'Test Store'
  );
});
afterAll(async () => {
  delete env.BETTER_AUTH_SECRET;
  delete env.BETTER_AUTH_URL;
  await dispose();
});

it('refuses signed-out and customer sessions', async () => {
  await expect(requireStaff(db, request())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  const cookie = await signIn('customer@example.com');
  await expect(requireStaff(db, request(cookie))).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('refuses staff without the session two-factor marker, admits with it', async () => {
  const cookie = await signIn('owner@example.com');
  await db
    .prepare("UPDATE user SET role='owner', two_factor_enabled=1 WHERE email='owner@example.com'")
    .run();
  await expect(requireStaff(db, request(cookie))).rejects.toMatchObject({
    code: 'TWO_FACTOR_REQUIRED',
  });
  const user = await db
    .prepare("SELECT id FROM user WHERE email='owner@example.com'")
    .first<{ id: string }>();
  const session = await db
    .prepare('SELECT token FROM session WHERE user_id=? ORDER BY created_at DESC LIMIT 1')
    .bind(user!.id)
    .first<{ token: string }>();
  await db
    .prepare(
      'INSERT INTO staff_two_factor_sessions(session_token_hash,user_id,verified_at) VALUES(?,?,?)'
    )
    .bind(await hashSessionToken(session!.token), user!.id, new Date().toISOString())
    .run();
  const staff = await requireStaff(db, request(cookie));
  expect(staff.email).toBe('owner@example.com');
});

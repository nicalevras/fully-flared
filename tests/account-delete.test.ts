import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { createAuth } from '../web/src/lib/auth';
import { deleteSignedInAccount } from '../web/src/lib/shopFns';

const base = 'http://localhost:8799';
const email = 'stale@example.invalid';
let db: D1Database, dispose: () => Promise<void>;
let auth: ReturnType<typeof createAuth>, headers: Headers;

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  auth = createAuth(db, base, 'account-delete-secret-at-least-32-characters');
  await auth.api.signUpEmail({ body: { name: 'Stale', email, password: 'password123' } });
  await db.prepare('UPDATE user SET email_verified = 1 WHERE email = ?').bind(email).run();
  const login = await auth.handler(
    new Request(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' }),
    })
  );
  expect(login.status).toBe(200);
  headers = new Headers({
    cookie: login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });
});
afterEach(() => dispose());

it('stale session gets the re-auth message', async () => {
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
  await db.prepare('UPDATE session SET created_at = ?').bind(twoDaysAgo).run();
  expect(await deleteSignedInAccount(auth, headers)).toEqual({
    ok: false,
    error: 'Sign in again to delete your account',
  });
  const user = await db.prepare('SELECT id FROM user WHERE email = ?').bind(email).first();
  expect(user).not.toBeNull();
});

it('fresh session deletes the account', async () => {
  expect(await deleteSignedInAccount(auth, headers)).toEqual({ ok: true });
  const user = await db.prepare('SELECT id FROM user WHERE email = ?').bind(email).first();
  expect(user).toBeNull();
});

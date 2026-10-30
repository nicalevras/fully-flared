import { describe, expect, it, vi } from 'vitest';
import { isRedirect } from '../web/node_modules/@tanstack/react-router';
import type { AuthErrorCode } from '../web/src/server/session';
import { signInSearch } from '../web/src/lib/search-params';
import { rawSearch } from './helpers/route';
import { Route, enterAdmin } from '../web/src/routes/admin/route';

const failure = vi.hoisted((): { code: AuthErrorCode } => ({ code: 'UNAUTHENTICATED' }));
vi.mock('../web/src/server/session', async (original) => {
  const actual = await original<typeof import('../web/src/server/session')>();
  return {
    ...actual,
    requireStaff: async () => {
      throw new actual.AuthError(failure.code, 'denied');
    },
  };
});
vi.mock('../web/node_modules/@tanstack/react-start', async (original) => {
  const chain = { middleware: () => chain, validator: () => chain, handler: (run: unknown) => run };
  return {
    ...(await original<typeof import('../web/node_modules/@tanstack/react-start')>()),
    createServerFn: () => chain,
  };
});
vi.mock('../web/node_modules/@tanstack/react-start/dist/esm/server.js', () => ({
  getRequest: () => new Request('http://localhost:8799/admin'),
}));

async function adminRedirect(code: AuthErrorCode, href: string) {
  failure.code = code;
  expect(Route.options.beforeLoad).toBe(enterAdmin);
  try {
    await enterAdmin({ location: { href } });
    return null;
  } catch (error) {
    if (isRedirect(error)) return error.options;
    throw error;
  }
}

describe('sign-in return path', () => {
  it('keeps same-origin paths with their query and hash', () => {
    expect(signInSearch({ ...rawSearch, redirect: '/admin' })).toEqual({ redirect: '/admin' });
    expect(signInSearch({ ...rawSearch, redirect: '/admin/orders?page=2#top' })).toEqual({
      redirect: '/admin/orders?page=2#top',
    });
  });

  it('drops anything that could leave the site or run code', () => {
    for (const redirect of [
      '//evil.com',
      '//evil.com/admin',
      '/\\evil.com',
      '/\t/evil.com',
      'https://evil.com',
      'javascript:alert(1)',
      'admin',
      '',
      `/${'a'.repeat(600)}`,
      42,
      null,
      undefined,
    ])
      expect(signInSearch({ ...rawSearch, redirect })).toEqual({ redirect: undefined });
  });
});

describe('admin guard', () => {
  it('sends signed-out visitors to sign-in with the page they asked for', async () => {
    expect(await adminRedirect('UNAUTHENTICATED', '/admin/products?page=2')).toMatchObject({
      to: '/auth/sign-in',
      search: { redirect: '/admin/products?page=2' },
    });
  });

  it('sends staff who still owe two-factor setup to the account page without a return path', async () => {
    expect(await adminRedirect('TWO_FACTOR_REQUIRED', '/admin')).toMatchObject({
      to: '/account',
    });
  });
});

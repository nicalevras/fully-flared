import { createMiddleware } from '@tanstack/react-start';
import { getRequest, setResponseStatus } from '@tanstack/react-start/server';
import { requireStaff, AuthError } from './session';

export type StaffContext = Awaited<ReturnType<typeof requireStaff>>;

/**
 * Staff gate for admin server functions (TanStack Start function middleware,
 * per the Start middleware guide): resolves the session once and passes the
 * typed staff context to handlers, so a handler that forgets its own check
 * is still behind an authenticated, 2FA-passed staff session.
 */
export const staffMiddleware = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const { env } = await import('cloudflare:workers');
  let staff: StaffContext;
  try {
    staff = await requireStaff(env.DB, getRequest());
  } catch (error) {
    setResponseStatus(error instanceof AuthError && error.code === 'UNAUTHENTICATED' ? 401 : 403);
    throw error;
  }
  return next({ context: { staff } });
});

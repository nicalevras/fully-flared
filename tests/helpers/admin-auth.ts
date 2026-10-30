import { vi } from 'vitest';
import type { AdminAuth } from '../../web/src/server/admin-actions';

async function notUnderTest(): Promise<never> {
  throw new Error('this admin endpoint is not part of the test');
}

/** Better Auth's admin endpoints with every permission check granted; role and session
 *  writes fail the test if reached. */
export function grantingAdminAuth() {
  const userHasPermission = vi.fn<AdminAuth['api']['userHasPermission']>(async () => ({
    success: true,
  }));
  const auth: AdminAuth = {
    api: { userHasPermission, setRole: notUnderTest, revokeUserSessions: notUnderTest },
  };
  return { auth, userHasPermission };
}

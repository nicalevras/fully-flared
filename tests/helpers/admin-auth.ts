import { vi } from 'vitest';
import type { AdminAuth } from '../../web/src/server/admin-actions';

/** Better Auth's admin permission check with every permission granted. */
export function grantingAdminAuth() {
  const userHasPermission = vi.fn<AdminAuth['api']['userHasPermission']>(async () => ({
    success: true,
  }));
  const auth: AdminAuth = {
    api: { userHasPermission },
  };
  return { auth, userHasPermission };
}

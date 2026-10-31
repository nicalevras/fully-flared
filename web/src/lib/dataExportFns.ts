import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { exportRequestSchema } from '../schemas/data-export';
import { validateServerInput } from '../server/function-boundary';

export const dataExportPageFn = createServerFn({ method: 'POST' })
  .validator(validateServerInput(exportRequestSchema))
  .handler(async ({ data }) => {
    const { workerEnv: env } = await import('../server/env');
    const { getSessionUser, requireStaff, AuthError } = await import('../server/session');
    const { isStaff } = await import('./auth');
    const { readDataExportPage } = await import('../server/data-export');
    const request = getRequest();
    const user = await getSessionUser(env.DB, request);
    if (!user) throw new AuthError('UNAUTHENTICATED', 'Sign in required');
    if (isStaff(user.role)) await requireStaff(env.DB, request);
    return readDataExportPage(env.DB, env.BETTER_AUTH_SECRET ?? '', user, data);
  });

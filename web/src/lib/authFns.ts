import { createServerFn } from '@tanstack/react-start';
import * as z from 'zod';
import { validateServerInput } from '../server/function-boundary';
import { getSettings } from '../server/settings';

export const getAuthConfig = createServerFn({ method: 'GET' })
  .validator(validateServerInput(z.object({})))
  .handler(async () => {
    const { env } = await import('cloudflare:workers');
    const settings = await getSettings(env.DB);
    return { turnstileSiteKey: settings.turnstileSiteKey };
  });

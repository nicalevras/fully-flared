import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { validateServerInput } from '../server/function-boundary';
import { availabilityInputSchema } from '../schemas/availability';
import { getAvailability } from '../server/availability';

export const getAvailabilityFn = createServerFn({ method: 'GET' })
  .validator(validateServerInput(availabilityInputSchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    setResponseHeader('Cache-Control', 'no-store');
    return getAvailability(
      data,
      env.DB,
      new URL(getRequest().url).origin,
      typeof caches === 'undefined' ? undefined : caches
    );
  });

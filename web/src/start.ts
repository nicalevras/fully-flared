import { createStart, createCsrfMiddleware } from '@tanstack/react-start';
import { functionBoundary } from './server/function-boundary';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const csrfMiddleware = createCsrfMiddleware({
  filter: ({ handlerType, request }) => {
    if (handlerType === 'serverFn') return true;
    const { pathname } = new URL(request.url);
    return (
      pathname.startsWith('/api/') &&
      !SAFE_METHODS.has(request.method) &&
      pathname !== '/api/webhooks/stripe'
    );
  },
});
export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  functionMiddleware: [functionBoundary],
}));

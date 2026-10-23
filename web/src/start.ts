import { createStart, createCsrfMiddleware } from '@tanstack/react-start';
import { functionBoundary } from './server/function-boundary';

const csrfMiddleware = createCsrfMiddleware({
  filter: (context) => context.handlerType === 'serverFn',
});
export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  functionMiddleware: [functionBoundary],
}));

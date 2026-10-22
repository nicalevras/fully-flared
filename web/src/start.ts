import { createStart } from '@tanstack/react-start';
import { functionBoundary } from './server/function-boundary';

export const startInstance = createStart(() => ({ functionMiddleware: [functionBoundary] }));

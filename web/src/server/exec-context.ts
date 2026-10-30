import { AsyncLocalStorage } from 'node:async_hooks';

// Carries the Workers ExecutionContext into library code that needs
// ctx.waitUntil (Better Auth background tasks) without threading it through
// every call. The Worker entry wraps each fetch in this storage.
export type RequestContext = Pick<ExecutionContext, 'waitUntil'>;
export const execCtxStorage = new AsyncLocalStorage<RequestContext>();
const requestReads = new AsyncLocalStorage<Map<object, Map<string, Promise<unknown>>>>();

export function runWithRequestContext<T>(ctx: RequestContext, operation: () => T): T {
  return execCtxStorage.run(ctx, () => requestReads.run(new Map(), operation));
}

/** Cache promises for this request only, including sequential reads. */
export function requestRead<T>(scope: object, key: string, load: () => Promise<T>): Promise<T> {
  const request = requestReads.getStore();
  if (!request) return load();
  let values = request.get(scope);
  if (!values) {
    values = new Map();
    request.set(scope, values);
  }
  const existing = values.get(key);
  if (existing) return existing as Promise<T>;
  const pending = load();
  values.set(key, pending);
  return pending;
}

export function waitUntil(promise: Promise<unknown>): void {
  const ctx = execCtxStorage.getStore();
  if (ctx) {
    ctx.waitUntil(promise);
  } else {
    // No execution context (tests, scripts): let it run and surface errors.
    void promise.catch((err) => console.error('background task failed', err));
  }
}

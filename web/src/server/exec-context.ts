import { AsyncLocalStorage } from 'node:async_hooks';

// Carries the Workers ExecutionContext into library code that needs
// ctx.waitUntil (Better Auth background tasks) without threading it through
// every call. The Worker entry wraps each fetch in this storage.
export type RequestContext = Pick<ExecutionContext, 'waitUntil'>;
export const execCtxStorage = new AsyncLocalStorage<RequestContext>();
/** Identifies the current request; request caches key their entries by it. */
const currentRequest = new AsyncLocalStorage<object>();

export function runWithRequestContext<T>(ctx: RequestContext, operation: () => T): T {
  return execCtxStorage.run(ctx, () => currentRequest.run({}, operation));
}

export type RequestCache<T> = (scope: object, key: string, load: () => Promise<T>) => Promise<T>;

/** Cache promises of one type for this request only, including sequential reads. */
export function requestCache<T>(): RequestCache<T> {
  const byRequest = new WeakMap<object, WeakMap<object, Map<string, Promise<T>>>>();
  return (scope, key, load) => {
    const request = currentRequest.getStore();
    if (!request) return load();
    let scopes = byRequest.get(request);
    if (!scopes) {
      scopes = new WeakMap();
      byRequest.set(request, scopes);
    }
    let values = scopes.get(scope);
    if (!values) {
      values = new Map();
      scopes.set(scope, values);
    }
    const existing = values.get(key);
    if (existing) return existing;
    const pending = load();
    values.set(key, pending);
    return pending;
  };
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

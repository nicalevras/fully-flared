import type { RequestContext } from '../../web/src/server/exec-context';

/** A value the test needs: a missing one fails here, by name, instead of as a TypeError later. */
export function present<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

export function at<T>(items: readonly T[], index: number): T {
  return present(items[index], `item ${index} of ${items.length}`);
}

/** The real object, with the listed members replaced: a spy or a fault on one method of a
 *  binding, while every other member keeps the real behaviour and type. */
export function withOverrides<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(base, prop) {
      if (Object.hasOwn(overrides, prop)) return Reflect.get(overrides, prop);
      const member: unknown = Reflect.get(base, prop);
      return typeof member === 'function' ? member.bind(base) : member;
    },
  });
}

/** A catalog document the test expects to be published at its slug, not moved away from it. */
export function published<T extends object>(
  value: T | { redirect: string } | null | undefined,
  what = 'document'
): T {
  const document = present(value, what);
  if ('redirect' in document) throw new Error(`expected ${what}, got a redirect`);
  return document;
}

/** A request context for code that only needs waitUntil; the test can await what it was handed. */
export function requestContext(): RequestContext & { pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil: (promise) => void pending.push(promise) };
}

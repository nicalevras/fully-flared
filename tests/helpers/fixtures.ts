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

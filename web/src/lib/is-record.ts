/** A non-null, non-array object, readable key by key. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The string at `key` of an object, or undefined when absent or not a string. */
export function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

/** The value as a string array, or undefined when any element is not a string. */
export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: unknown[] = value;
  const strings = items.filter((item): item is string => typeof item === 'string');
  return strings.length === items.length ? strings : undefined;
}

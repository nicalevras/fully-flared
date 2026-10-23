// Shared formatting helpers. One implementation, used by storefront, admin,
// and server mail so money and dates never render differently per page.
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

function storedDate(value: string | number | Date): Date {
  // SQLite's zone-less datetime strings are UTC, just like stored ISO instants.
  return new Date(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
      ? value.replace(' ', 'T') + 'Z'
      : value
  );
}

export function formatDate(value: string | number | Date, timeZone = 'UTC'): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone,
  }).format(storedDate(value));
}

export function formatDateTime(value: string | number | Date, timeZone = 'UTC'): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(storedDate(value));
}

/** Stored UTC ISO instant -> `datetime-local` input value in the
 * editor's local zone (or the given zone). Invalid input yields ''. */
export function utcToLocalDateTimeInput(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

export type LoadedSchedule = { localValue: string; iso: string };

/** Resolve the ISO instant to send for a post save. An unchanged local
 * value returns the originally stored ISO verbatim — during the DST
 * fall-back repeated hour, one local wall time names two instants, and
 * reconverting would silently move the post to the other one. */
export function resolveScheduledIso(
  status: string,
  localValue: string,
  loaded?: LoadedSchedule | null
): { ok: true; iso: string } | { ok: false; error: string } {
  if (status !== 'scheduled') return { ok: true, iso: '' };
  if (!localValue || Number.isNaN(new Date(localValue).getTime()))
    return { ok: false, error: 'Choose a publish date and time for a scheduled post.' };
  if (loaded && localValue === loaded.localValue) return { ok: true, iso: loaded.iso };
  return { ok: true, iso: new Date(localValue).toISOString() };
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

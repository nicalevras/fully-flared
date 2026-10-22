import {
  LIMIT_KEYS,
  storeLimitsSchema,
  ADMISSION_KEYS,
  admissionConfigSchema,
} from '../schemas/limits';

export type SettingsActionResult = { ok: boolean; error?: string };
export type SettingsAction = (
  action: string,
  payload: Record<string, string>
) => Promise<SettingsActionResult>;

/** The settings page save flow: limits, then store/email fields, then the
 * two tax writes. Every write is checked; the first failure stops the
 * save and reports its error, so success is only reported when all
 * writes — tax included — actually succeeded. */
export async function saveSettings(
  action: SettingsAction,
  input: {
    limits: Record<string, number>;
    admission: Record<string, number>;
    form: Record<string, string>;
    tax: { enabled: boolean; confirmed: boolean };
  }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!storeLimitsSchema.safeParse(input.limits).success)
    return {
      ok: false,
      error: 'Each store limit must be a whole number within its displayed range.',
    };
  if (!admissionConfigSchema.safeParse(input.admission).success)
    return {
      ok: false,
      error: 'Each admission budget must be a whole number within its displayed range.',
    };
  const writes: Array<[string, string]> = [
    ...LIMIT_KEYS.map((key): [string, string] => [key, String(input.limits[key])]),
    ...ADMISSION_KEYS.map((key): [string, string] => [key, String(input.admission[key])]),
    ...Object.entries(input.form),
    ['stripe_tax_enabled', input.tax.enabled ? '1' : '0'],
    ['stripe_tax_confirmed', input.tax.confirmed ? '1' : '0'],
  ];
  for (const [key, value] of writes) {
    const result = await action('settings.set', { key, value });
    if (!result.ok) return { ok: false, error: result.error ?? `Failed saving ${key}` };
  }
  return { ok: true };
}

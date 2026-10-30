import {
  ADMISSION_DEFINITIONS,
  ADMISSION_KEYS,
  LIMIT_DEFINITIONS,
  LIMIT_KEYS,
  withinDefinitions,
} from './settings-definitions';

export type SettingChange = { key: string; value: string; expectedUpdatedAt: string | null };
export type SettingsActionResult = { ok: boolean; error?: string; conflict?: boolean };
export type SettingsAction = (
  action: 'settings.setMany',
  payload: { changes: SettingChange[] }
) => Promise<SettingsActionResult>;

export type SettingsSnapshot = {
  limits: Record<string, number>;
  admission: Record<string, number>;
  form: Record<string, string>;
  tax: { enabled: boolean; confirmed: boolean };
};

function storedValues(snapshot: SettingsSnapshot): Array<[string, string]> {
  return [
    ...LIMIT_KEYS.map((key): [string, string] => [key, String(snapshot.limits[key])]),
    ...ADMISSION_KEYS.map((key): [string, string] => [key, String(snapshot.admission[key])]),
    ...Object.entries(snapshot.form),
    ['stripe_tax_enabled', snapshot.tax.enabled ? '1' : '0'],
    ['stripe_tax_confirmed', snapshot.tax.confirmed ? '1' : '0'],
  ];
}

/** The keys whose value differs from what the page loaded. */
export function changedSettings(initial: SettingsSnapshot, next: SettingsSnapshot) {
  const before = new Map(storedValues(initial));
  return storedValues(next).filter(([key, value]) => before.get(key) !== value);
}

/** The settings page save: every changed key goes in one batch that the
 * server applies all-or-nothing, each guarded by the version the page
 * loaded, so a concurrent edit is reported instead of overwritten. */
export async function saveSettings(
  action: SettingsAction,
  input: {
    initial: SettingsSnapshot;
    next: SettingsSnapshot;
    versions: Record<string, string>;
  }
): Promise<{ ok: true } | { ok: false; error: string; conflict?: true }> {
  if (!withinDefinitions(input.next.limits, LIMIT_DEFINITIONS))
    return {
      ok: false,
      error: 'Each store limit must be a whole number within its displayed range.',
    };
  if (!withinDefinitions(input.next.admission, ADMISSION_DEFINITIONS))
    return {
      ok: false,
      error: 'Each admission budget must be a whole number within its displayed range.',
    };
  const changes = changedSettings(input.initial, input.next).map(([key, value]) => ({
    key,
    value,
    expectedUpdatedAt: input.versions[key] ?? null,
  }));
  if (changes.length === 0) return { ok: true };
  const result = await action('settings.setMany', { changes });
  if (result.ok) return { ok: true };
  return {
    ok: false,
    error: result.error ?? 'Settings were not saved',
    ...(result.conflict ? { conflict: true } : {}),
  };
}

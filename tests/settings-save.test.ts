import { describe, expect, it } from 'vitest';

import { saveSettings, type SettingsAction } from '../web/src/lib/settings-save';
import {
  ADMISSION_DEFINITIONS,
  ADMISSION_KEYS,
  LIMIT_DEFINITIONS,
  LIMIT_KEYS,
} from '../web/src/lib/settings-definitions';

const limits = Object.fromEntries(LIMIT_KEYS.map((key) => [key, LIMIT_DEFINITIONS[key].default]));
const admission = Object.fromEntries(
  ADMISSION_KEYS.map((key) => [key, ADMISSION_DEFINITIONS[key].default])
);
const form = { store_name: 'Shop', currency: 'USD', canonical_base_url: 'https://shop.invalid' };

function fakeAction(failKey?: string) {
  const calls: Array<[string, string]> = [];
  const action: SettingsAction = async (_action, payload) => {
    calls.push([payload.key ?? '', payload.value ?? '']);
    if (payload.key === failKey) return { ok: false, error: `Failed saving ${failKey}` };
    return { ok: true };
  };
  return { action, calls };
}

describe('settings save flow', () => {
  it('succeeds only when every write, tax included, succeeds', async () => {
    const { action, calls } = fakeAction();
    const result = await saveSettings(action, {
      limits,
      admission,
      form,
      tax: { enabled: true, confirmed: true },
    });
    expect(result).toEqual({ ok: true });
    expect(calls.slice(-2)).toEqual([
      ['stripe_tax_enabled', '1'],
      ['stripe_tax_confirmed', '1'],
    ]);
    expect(calls.map(([key]) => key)).toContain('canonical_base_url');
  });

  it('failed stripe_tax_enabled write reports the error and stops before the success state', async () => {
    const { action, calls } = fakeAction('stripe_tax_enabled');
    const result = await saveSettings(action, {
      limits,
      admission,
      form,
      tax: { enabled: true, confirmed: true },
    });
    expect(result).toEqual({ ok: false, error: 'Failed saving stripe_tax_enabled' });
    expect(calls.map(([key]) => key)).not.toContain('stripe_tax_confirmed');
  });

  it('failed stripe_tax_confirmed write reports the error after the enable write succeeded', async () => {
    const { action, calls } = fakeAction('stripe_tax_confirmed');
    const result = await saveSettings(action, {
      limits,
      admission,
      form,
      tax: { enabled: false, confirmed: true },
    });
    expect(result).toEqual({ ok: false, error: 'Failed saving stripe_tax_confirmed' });
    expect(calls.slice(-2)).toEqual([
      ['stripe_tax_enabled', '0'],
      ['stripe_tax_confirmed', '1'],
    ]);
  });
});

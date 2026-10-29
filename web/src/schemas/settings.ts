import * as z from 'zod';
import { limitValueSchema, admissionValueSchema } from './limits';
import {
  LIMIT_KEYS,
  isLimitKey,
  ADMISSION_KEYS,
  SUPPORTED_CURRENCIES,
  type AdmissionKey,
} from '../lib/settings-definitions';

const ADMISSION_KEY_SET = new Set<string>(ADMISSION_KEYS);
export function isAdmissionKey(key: string): key is AdmissionKey {
  return ADMISSION_KEY_SET.has(key);
}

// Settings live in D1 as string key/value rows. They are parsed once in
// getSettings; inside the app the typed object is trusted.
export const settingsRowSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string().max(2000),
});

export const settingsMapSchema = z.record(z.string(), z.string());

export const settingKeySchema = z.enum([
  ...LIMIT_KEYS,
  ...ADMISSION_KEYS,
  'operational_alert_email',
  'turnstile_site_key',
  'store_name',
  'logo_media_id',
  'hero_media_id',
  'currency',
  'canonical_base_url',
  'email_from_name',
  'email_from_address',
  'stripe_tax_enabled',
  'stripe_tax_confirmed',
  'collect_shipping',
  'announcement_text',
  'seo_title_template',
  'abandoned_reminders_enabled',
  'media_public_base_url',
]);
export type SettingKey = z.infer<typeof settingKeySchema>;

export const currencyCodeSchema = z.enum(SUPPORTED_CURRENCIES);

export function validateSetting(key: string, value: string): void {
  settingKeySchema.parse(key);
  if (isLimitKey(key)) limitValueSchema(key).parse(value);
  else if (isAdmissionKey(key)) admissionValueSchema(key).parse(value);
  else if (
    [
      'stripe_tax_enabled',
      'stripe_tax_confirmed',
      'collect_shipping',
      'abandoned_reminders_enabled',
    ].includes(key)
  )
    z.enum(['0', '1']).parse(value);
  else if (key === 'currency') currencyCodeSchema.parse(value);
  else if (['email_from_address', 'operational_alert_email'].includes(key)) {
    if (value || key === 'email_from_address') z.email().parse(value);
  } else if ((key === 'canonical_base_url' || key === 'media_public_base_url') && value) {
    const url = new URL(z.url().parse(value));
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value.replace(/\/$/, ''))
      throw new Error('Canonical URL must be an HTTP origin');
    if (key === 'media_public_base_url' && url.protocol !== 'https:')
      throw Error('Public media requires HTTPS');
  } else z.string().max(2000).parse(value);
}

// These values are embedded in the published layout model; keep the
// catalog_work settings-capture trigger list (migration 0004) aligned.
export const PUBLISHED_SETTING_KEYS: readonly string[] = [
  ...LIMIT_KEYS,
  'media_public_base_url',
  'store_name',
  'logo_media_id',
  'hero_media_id',
  'currency',
  'canonical_base_url',
  'announcement_text',
  'seo_title_template',
];

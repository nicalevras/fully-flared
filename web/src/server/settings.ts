import { getDb } from '../db/client';
import { settings as settingsT } from '../db/schema';
import { parseLimits, parseAdmissionConfig } from '../schemas/limits';
import type { StoreLimits, AdmissionConfig } from '../lib/settings-definitions';
import {
  currencyCodeSchema,
  settingsMapSchema,
  validateSetting,
  settingKeySchema,
} from '../schemas/settings';

// Store settings are installer data in D1, never hardcoded identity.
export type StoreSettings = {
  limits: StoreLimits;
  /** Checkout admission budgets (Phase 5), read by CheckoutAdmissionDO. */
  admission: AdmissionConfig;
  storeName: string;
  currency: string;
  currencyLocked: boolean;
  canonicalBaseUrl: string;
  emailFromName: string;
  emailFromAddress: string;
  operationalAlertEmail: string;
  stripeTaxEnabled: boolean;
  stripeTaxConfirmed: boolean;
  collectShipping: boolean;
  announcementText: string;
  seoTitleTemplate: string;
  turnstileSiteKey: string;
  /** Commerce-configuration revision (Phase 2): advanced by migration
   *  0002 triggers on pricing/shipping/coupon/settings changes, never by
   *  stock movement. Quotes carry it; the reservation batch rejects a
   *  stale revision so a shopper never silently pays a changed price. */
  configRevision: number;
  abandonedRemindersEnabled: boolean;
  mediaPublicBaseUrl: string;
};

const DEFAULTS: Record<string, string> = {
  store_name: 'My Store',
  currency: 'USD',
  currency_locked: '0',
  canonical_base_url: '',
  email_from_name: 'My Store',
  email_from_address: 'orders@example.com',
  operational_alert_email: '',
  stripe_tax_enabled: '0',
  stripe_tax_confirmed: '0',
  collect_shipping: '1',
  announcement_text: '',
  seo_title_template: '{product} · {store_name}',
  turnstile_site_key: '',
  abandoned_reminders_enabled: '0',
  media_public_base_url: '',
};

export async function getSettings(db: D1Database): Promise<StoreSettings> {
  const rows = await getDb(db)
    .select({ key: settingsT.key, value: settingsT.value })
    .from(settingsT);
  const stored = settingsMapSchema.parse(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  for (const [key, value] of Object.entries(stored))
    if (settingKeySchema.safeParse(key).success) {
      try {
        validateSetting(key, value);
      } catch {
        delete stored[key];
        console.error(JSON.stringify({ event: 'invalid_stored_setting', key }));
      }
    }
  const map: Record<string, string> = { ...DEFAULTS, ...stored };
  // A malformed stored currency must never reach Stripe/Intl: fall back
  // to the default rather than throwing at checkout time.
  if (!currencyCodeSchema.safeParse(map.currency).success)
    map.currency = DEFAULTS.currency ?? 'USD';
  const v = (key: string): string => map[key] ?? '';
  return {
    limits: parseLimits(stored),
    admission: parseAdmissionConfig(stored),
    storeName: v('store_name'),
    currency: v('currency'),
    currencyLocked: v('currency_locked') === '1',
    canonicalBaseUrl: v('canonical_base_url'),
    emailFromName: v('email_from_name'),
    emailFromAddress: v('email_from_address'),
    operationalAlertEmail: v('operational_alert_email'),
    stripeTaxEnabled: v('stripe_tax_enabled') === '1',
    stripeTaxConfirmed: v('stripe_tax_confirmed') === '1',
    collectShipping: v('collect_shipping') === '1',
    announcementText: v('announcement_text'),
    seoTitleTemplate: v('seo_title_template'),
    turnstileSiteKey: v('turnstile_site_key'),
    configRevision: Number.parseInt(v('commerce_revision') || '0', 10) || 0,
    abandonedRemindersEnabled: v('abandoned_reminders_enabled') === '1',
    mediaPublicBaseUrl: v('media_public_base_url'),
  };
}

export async function setSetting(db: D1Database, key: string, value: string) {
  validateSetting(key, value);
  const now = new Date().toISOString();
  await getDb(db)
    .insert(settingsT)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settingsT.key, set: { value, updatedAt: now } });
}

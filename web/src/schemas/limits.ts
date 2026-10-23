import * as z from 'zod';

export const LIMIT_KEYS = [
  'checkout_email_cap',
  'checkout_account_cap',
  'checkout_ip_cap',
  'cart_max_qty',
  'cart_max_lines',
  'order_max_units',
  'checkout_session_minutes',
  'refund_retry_cap',
  'refund_stuck_minutes',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type StoreLimits = Record<LimitKey, number>;
export class StoreLimitError extends Error {}
export const LIMIT_DEFINITIONS = {
  checkout_email_cap: { min: 1, max: 100, default: 5, label: 'Open checkouts per email / hour' },
  checkout_account_cap: {
    min: 1,
    max: 100,
    default: 5,
    label: 'Open checkouts per account / hour',
  },
  checkout_ip_cap: { min: 1, max: 1000, default: 10, label: 'Open checkouts per network / hour' },
  cart_max_qty: { min: 1, max: 999, default: 99, label: 'Units per cart line' },
  // Stripe Checkout payment mode permits at most 100 line items.
  cart_max_lines: { min: 1, max: 100, default: 50, label: 'Distinct cart lines' },
  order_max_units: { min: 1, max: 10000, default: 500, label: 'Units per order' },
  // Two minutes of creation margin above Stripe's minimum session lifetime.
  checkout_session_minutes: {
    min: 32,
    max: 1440,
    default: 32,
    label: 'Stripe Checkout Session (minutes)',
  },
  refund_retry_cap: { min: 1, max: 20, default: 5, label: 'Refund attempts' },
  refund_stuck_minutes: { min: 1, max: 10080, default: 60, label: 'Stuck refund alert (minutes)' },
} as const satisfies Record<LimitKey, { min: number; max: number; default: number; label: string }>;

export function isLimitKey(key: string): key is LimitKey {
  return Object.hasOwn(LIMIT_DEFINITIONS, key);
}
export function limitValueSchema(key: LimitKey) {
  const { min, max } = LIMIT_DEFINITIONS[key];
  return z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}
export function parseLimits(stored: Record<string, string>): StoreLimits {
  return Object.fromEntries(
    LIMIT_KEYS.map((key) => {
      const parsed = limitValueSchema(key).safeParse(stored[key]);
      return [key, parsed.success ? parsed.data : LIMIT_DEFINITIONS[key].default];
    })
  ) as StoreLimits;
}

export const storeLimitsSchema = z
  .record(z.enum(LIMIT_KEYS), z.number())
  .superRefine((limits, ctx) => {
    for (const key of LIMIT_KEYS) {
      const { min, max } = LIMIT_DEFINITIONS[key];
      if (!Number.isSafeInteger(limits[key]) || limits[key] < min || limits[key] > max)
        ctx.addIssue({ code: 'custom', path: [key], message: `Expected integer ${min}..${max}` });
    }
  });

/** Existing immutable layouts keep their original hash. Normalize only the
 * returned view while the new publisher replaces the old setting name. */
export function publishedLimits(limits: Record<string, number>): StoreLimits {
  const normalized = { ...limits };
  if (
    normalized.checkout_session_minutes === undefined &&
    normalized.checkout_hold_minutes !== undefined
  ) {
    normalized.checkout_session_minutes = Math.max(
      32,
      Math.min(1440, normalized.checkout_hold_minutes - 10)
    );
    delete normalized.checkout_hold_minutes;
  }
  return storeLimitsSchema.parse(normalized);
}

// Checkout admission budgets (Phase 5). Stored as settings rows like
// the limits above, but kept out of StoreLimits: limits are serialized
// into the public storefront layout, while admission tuning is an
// internal controller concern that must never purge or leak into it.
// The defaults are conservative starting budgets, not measured
// capacity claims.
export const ADMISSION_KEYS = [
  'admission_starts_per_second',
  'admission_burst',
  'admission_max_active',
] as const;
export type AdmissionKey = (typeof ADMISSION_KEYS)[number];
export type AdmissionConfig = Record<AdmissionKey, number>;
export const ADMISSION_DEFINITIONS = {
  admission_starts_per_second: {
    min: 1,
    max: 100,
    default: 5,
    label: 'Checkout starts per second',
  },
  admission_burst: { min: 1, max: 200, default: 10, label: 'Checkout burst allowance' },
  admission_max_active: { min: 1, max: 200, default: 10, label: 'Active checkout initiations' },
} as const satisfies Record<
  AdmissionKey,
  { min: number; max: number; default: number; label: string }
>;

export function admissionValueSchema(key: AdmissionKey) {
  const { min, max } = ADMISSION_DEFINITIONS[key];
  return z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

export function parseAdmissionConfig(stored: Record<string, string>): AdmissionConfig {
  return Object.fromEntries(
    ADMISSION_KEYS.map((key) => {
      const parsed = admissionValueSchema(key).safeParse(stored[key]);
      return [key, parsed.success ? parsed.data : ADMISSION_DEFINITIONS[key].default];
    })
  ) as AdmissionConfig;
}

export const admissionConfigSchema = z
  .record(z.enum(ADMISSION_KEYS), z.number())
  .superRefine((config, ctx) => {
    for (const key of ADMISSION_KEYS) {
      const { min, max } = ADMISSION_DEFINITIONS[key];
      if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max)
        ctx.addIssue({ code: 'custom', path: [key], message: `Expected integer ${min}..${max}` });
    }
  });

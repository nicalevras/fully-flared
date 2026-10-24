// Settings bounds and choices shared by the server and the admin page.
// Kept free of zod so browser chunks that import it stay small.

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

export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF'] as const;

/** Every defined key holds a safe integer within its bounds, and no other key is present. */
export function withinDefinitions(
  values: Record<string, number>,
  definitions: Record<string, { min: number; max: number }>
): boolean {
  return (
    Object.keys(values).every((key) => Object.hasOwn(definitions, key)) &&
    Object.entries(definitions).every(([key, { min, max }]) => {
      const value = values[key];
      return value !== undefined && Number.isSafeInteger(value) && value >= min && value <= max;
    })
  );
}

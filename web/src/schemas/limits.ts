import * as z from 'zod';
import {
  ADMISSION_DEFINITIONS,
  ADMISSION_KEYS,
  LIMIT_DEFINITIONS,
  LIMIT_KEYS,
  type AdmissionConfig,
  type AdmissionKey,
  type LimitKey,
  type StoreLimits,
} from '../lib/settings-definitions';

export function limitValueSchema(key: LimitKey) {
  const { min, max } = LIMIT_DEFINITIONS[key];
  return z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
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

export function parseLimits(stored: Record<string, string>): StoreLimits {
  return storeLimitsSchema.parse(
    Object.fromEntries(
      LIMIT_KEYS.map((key) => {
        const parsed = limitValueSchema(key).safeParse(stored[key]);
        return [key, parsed.success ? parsed.data : LIMIT_DEFINITIONS[key].default];
      })
    )
  );
}

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

export function admissionValueSchema(key: AdmissionKey) {
  const { min, max } = ADMISSION_DEFINITIONS[key];
  return z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

const admissionConfigSchema = z.record(z.enum(ADMISSION_KEYS), z.number());

export function parseAdmissionConfig(stored: Record<string, string>): AdmissionConfig {
  return admissionConfigSchema.parse(
    Object.fromEntries(
      ADMISSION_KEYS.map((key) => {
        const parsed = admissionValueSchema(key).safeParse(stored[key]);
        return [key, parsed.success ? parsed.data : ADMISSION_DEFINITIONS[key].default];
      })
    )
  );
}

import { parseAdmissionConfig } from '../schemas/limits';
import { ADMISSION_KEYS, type AdmissionConfig } from '../lib/settings-definitions';

// Checkout admission control (Phase 5). A per-store token bucket plus
// an active-permit budget, enforced synchronously by
// CheckoutAdmissionDO. This module holds the pure decision core and
// the caller-side helper; the Durable Object is a thin storage
// adapter over the core, and no D1 or provider call ever happens
// inside its storage transactions.
//
// Admission bounds admitted initialization work. It does not enforce
// an exact count of the provider's internal processing, and an
// expired lease does not prove an already-sent provider request
// stopped — it only restores local capacity after a crash.

export const PERMIT_TTL_MS = 120_000;

export interface AdmissionStorage {
  readBucket(): { tokens: number; updatedAtMs: number } | null;
  writeBucket(tokens: number, updatedAtMs: number): void;
  countActivePermits(nowMs: number): number;
  addPermit(id: string, deadlineMs: number): void;
  removePermit(id: string): boolean;
  deleteExpiredPermits(nowMs: number): number;
  nextPermitDeadline(): number | null;
}

export type AcquireResult =
  { ok: true; permitId: string } | { ok: false; retryAfterSeconds: number };

export function createAdmission(
  storage: AdmissionStorage,
  config: () => AdmissionConfig,
  newPermitId: () => string = () => crypto.randomUUID()
) {
  return {
    /** One synchronous decision: refill, expire, then admit or deny. */
    acquire(nowMs: number): AcquireResult {
      const cfg = config();
      storage.deleteExpiredPermits(nowMs);
      const bucket = storage.readBucket() ?? {
        tokens: cfg.admission_burst,
        updatedAtMs: nowMs,
      };
      const elapsedSeconds = Math.max(0, (nowMs - bucket.updatedAtMs) / 1000);
      const tokens = Math.min(
        cfg.admission_burst,
        bucket.tokens + elapsedSeconds * cfg.admission_starts_per_second
      );
      const active = storage.countActivePermits(nowMs);
      if (tokens >= 1 && active < cfg.admission_max_active) {
        const permitId = newPermitId();
        storage.addPermit(permitId, nowMs + PERMIT_TTL_MS);
        storage.writeBucket(tokens - 1, nowMs);
        return { ok: true, permitId };
      }
      storage.writeBucket(tokens, nowMs);
      const waits: number[] = [];
      if (tokens < 1) waits.push((1 - tokens) / cfg.admission_starts_per_second);
      if (active >= cfg.admission_max_active) {
        const next = storage.nextPermitDeadline();
        if (next != null) waits.push(Math.max(0, (next - nowMs) / 1000));
      }
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil(Math.max(0, ...waits))),
      };
    },
    /** Idempotent: releasing an unknown or expired permit is a no-op. */
    release(permitId: string): boolean {
      return storage.removePermit(permitId);
    },
    /** Drops expired permits, restoring capacity after crashes. */
    sweepExpired(nowMs: number): number {
      return storage.deleteExpiredPermits(nowMs);
    },
    nextPermitDeadline(): number | null {
      return storage.nextPermitDeadline();
    },
  };
}

/** The bounded starting budgets, used before any settings read lands. */
export function parseAdmissionConfigFromDefaults(): AdmissionConfig {
  return parseAdmissionConfig({});
}

/** Admission budgets from the settings table. Missing or malformed
 *  rows resolve to the bounded defaults, never to unlimited. */
export async function loadAdmissionConfig(db: D1Database): Promise<AdmissionConfig> {
  const placeholders = ADMISSION_KEYS.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
    .bind(...ADMISSION_KEYS)
    .all<{ key: string; value: string }>();
  return parseAdmissionConfig(Object.fromEntries(rows.results.map((r) => [r.key, r.value])));
}

export type AdmissionStub = {
  acquire(): Promise<AcquireResult>;
  release(permitId: string): Promise<unknown>;
};

export type AdmissionPermit =
  | { kind: 'acquired'; release: () => Promise<void> }
  | { kind: 'busy'; retryAfterSeconds: number }
  | { kind: 'unavailable' };

/** Acquires one permit from the lane's controller. `start` admits new
 *  checkouts; `settle` serves already-authorized payments and refunds,
 *  so a rush of new checkouts can't starve them. Both use the same limits.
 *  A missing binding or a failed RPC is `unavailable` (the caller
 *  fails closed with 503); a full budget is `busy` (429). */
export async function acquireCheckoutPermit(
  namespace: { getByName(name: string): AdmissionStub } | undefined,
  lane: 'start' | 'settle'
): Promise<AdmissionPermit> {
  if (!namespace) return { kind: 'unavailable' };
  try {
    const stub = namespace.getByName(lane === 'settle' ? 'settle' : 'store');
    const result = await stub.acquire();
    if (!result.ok) return { kind: 'busy', retryAfterSeconds: result.retryAfterSeconds };
    const permitId = result.permitId;
    return {
      kind: 'acquired',
      release: async () => {
        // Release is best-effort: the 120 s lease restores the slot
        // even if this call never lands.
        await stub.release(permitId).catch(() => undefined);
      },
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

import {
  createAdmission,
  parseAdmissionConfigFromDefaults,
  type AdmissionStorage,
} from '../../web/src/server/checkout-admission';
import type { AdmissionConfig } from '../../web/src/lib/settings-definitions';

function admissionObject(config: AdmissionConfig) {
  const bucket: { tokens: number | null; updatedAtMs: number } = { tokens: null, updatedAtMs: 0 };
  const permits = new Map<string, number>();
  const storage: AdmissionStorage = {
    readBucket: () =>
      bucket.tokens == null ? null : { tokens: bucket.tokens, updatedAtMs: bucket.updatedAtMs },
    writeBucket: (tokens, updatedAtMs) => {
      bucket.tokens = tokens;
      bucket.updatedAtMs = updatedAtMs;
    },
    countActivePermits: (nowMs) =>
      [...permits.values()].filter((deadline) => deadline > nowMs).length,
    addPermit: (id, deadlineMs) => {
      permits.set(id, deadlineMs);
    },
    removePermit: (id) => permits.delete(id),
    deleteExpiredPermits: (nowMs) => {
      let removed = 0;
      for (const [id, deadline] of permits) {
        if (deadline <= nowMs) {
          permits.delete(id);
          removed++;
        }
      }
      return removed;
    },
    nextPermitDeadline: () => (permits.size ? Math.min(...permits.values()) : null),
  };
  const admission = createAdmission(storage, () => config);
  const stub = {
    acquire: async () => admission.acquire(Date.now()),
    release: async (permitId: string) => {
      admission.release(permitId);
    },
  };
  return { admission, permits, stub };
}

// Test double for the CheckoutAdmissionDO namespace, backed by the
// real admission core over in-memory storage, so route tests exercise
// the production decision logic rather than a re-implemented fake.
// Each name is its own object, like getByName on a real namespace;
// `admission` and `permits` belong to the checkout-start object.
export function fakeAdmissionNamespace(
  config: AdmissionConfig = parseAdmissionConfigFromDefaults()
) {
  const objects = new Map<string, ReturnType<typeof admissionObject>>();
  const byName = (name: string) => {
    const existing = objects.get(name);
    if (existing) return existing;
    const created = admissionObject(config);
    objects.set(name, created);
    return created;
  };
  const store = byName('store');
  return {
    namespace: { getByName: (name: string) => byName(name).stub },
    admission: store.admission,
    permits: store.permits,
  };
}

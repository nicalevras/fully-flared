import { quoteOrder } from '../web/src/server/checkout';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { handleCheckoutRequest } from '../web/src/routes/api/checkout';
import {
  createAdmission,
  acquireCheckoutPermit,
  parseAdmissionConfigFromDefaults,
  PERMIT_TTL_MS,
  type AdmissionStorage,
} from '../web/src/server/checkout-admission';
import { parseAdmissionConfig } from '../web/src/schemas/limits';
import { fakeAdmissionNamespace } from './helpers/admission';

vi.mock('../web/src/server/session', () => ({ getSessionUser: async () => null }));
vi.mock('../web/src/server/turnstile', () => ({ verifyTurnstile: async () => true }));

const provider = {
  createCheckout: vi.fn(),
  createCoupon: vi.fn(),
  createCheckoutSession: vi.fn(),
  async verifyWebhook(payload: string) {
    const event = JSON.parse(payload);
    return { ...event, data: event.data.object };
  },
  refund: vi.fn(async () => ({ id: 're_x', status: 'pending' })),
};
vi.mock('../web/src/server/payments', () => ({ getStripeProvider: () => provider }));

// ---------------------------------------------------------------- core

function memoryStorage() {
  const state = {
    bucket: null as { tokens: number; updatedAtMs: number } | null,
    permits: new Map<string, number>(),
  };
  const storage: AdmissionStorage = {
    readBucket: () => state.bucket,
    writeBucket: (tokens, updatedAtMs) => {
      state.bucket = { tokens, updatedAtMs };
    },
    countActivePermits: (nowMs) => [...state.permits.values()].filter((d) => d > nowMs).length,
    addPermit: (id, deadlineMs) => {
      state.permits.set(id, deadlineMs);
    },
    removePermit: (id) => state.permits.delete(id),
    deleteExpiredPermits: (nowMs) => {
      let removed = 0;
      for (const [id, d] of state.permits)
        if (d <= nowMs) {
          state.permits.delete(id);
          removed++;
        }
      return removed;
    },
    nextPermitDeadline: () => (state.permits.size ? Math.min(...state.permits.values()) : null),
  };
  return { state, storage };
}

const cfg = (startsPerSecond: number, burst: number, maxActive: number) => () => ({
  admission_starts_per_second: startsPerSecond,
  admission_burst: burst,
  admission_max_active: maxActive,
});

it('admits up to the burst, refills at the configured rate, and caps active permits', () => {
  const { storage } = memoryStorage();
  const admission = createAdmission(storage, cfg(2, 3, 10));
  const t0 = 1_000_000;
  expect(admission.acquire(t0).ok).toBe(true);
  expect(admission.acquire(t0).ok).toBe(true);
  expect(admission.acquire(t0).ok).toBe(true);
  const denied = admission.acquire(t0);
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.retryAfterSeconds).toBe(1); // half a second to the next token
  // One second later exactly two tokens have refilled.
  expect(admission.acquire(t0 + 1000).ok).toBe(true);
  expect(admission.acquire(t0 + 1000).ok).toBe(true);
  expect(admission.acquire(t0 + 1000).ok).toBe(false);

  const active = createAdmission(memoryStorage().storage, cfg(1000, 1000, 2));
  expect(active.acquire(t0).ok).toBe(true);
  expect(active.acquire(t0).ok).toBe(true);
  expect(active.acquire(t0).ok).toBe(false);
});

it('release is idempotent and lease expiry restores capacity after a crash', () => {
  const { state, storage } = memoryStorage();
  const admission = createAdmission(storage, cfg(0.001, 10, 1));
  const t0 = 5_000_000;
  const first = admission.acquire(t0);
  expect(first.ok).toBe(true);
  expect(admission.acquire(t0).ok).toBe(false);
  if (first.ok) {
    expect(admission.release(first.permitId)).toBe(true);
    expect(admission.release(first.permitId)).toBe(false); // duplicate release: no-op
  }
  expect(admission.acquire(t0).ok).toBe(true);
  // Simulate a crash: the permit is never released. After its lease
  // expires, a fresh core over the same storage (a restarted DO)
  // sweeps it and admits again.
  const restarted = createAdmission(storage, cfg(0.001, 10, 1));
  expect(restarted.acquire(t0 + PERMIT_TTL_MS - 1).ok).toBe(false);
  expect(restarted.sweepExpired(t0 + PERMIT_TTL_MS)).toBe(1);
  expect(restarted.acquire(t0 + PERMIT_TTL_MS).ok).toBe(true);
  expect(state.permits.size).toBe(1);
});

it('config parsing is bounded: defaults for missing or malformed rows, never unlimited', () => {
  expect(parseAdmissionConfig({})).toEqual(parseAdmissionConfigFromDefaults());
  expect(
    parseAdmissionConfig({
      admission_starts_per_second: '99999',
      admission_burst: '0',
      admission_max_active: 'abc',
    })
  ).toEqual(parseAdmissionConfigFromDefaults());
  expect(
    parseAdmissionConfig({
      admission_starts_per_second: '7',
      admission_burst: '30',
      admission_max_active: '12',
    })
  ).toEqual({ admission_starts_per_second: 7, admission_burst: 30, admission_max_active: 12 });
});

it('client helper fails closed: missing binding or RPC error is unavailable, full budget is busy', async () => {
  expect(await acquireCheckoutPermit(undefined)).toEqual({ kind: 'unavailable' });
  expect(
    await acquireCheckoutPermit({
      getByName: () => ({
        acquire: async () => {
          throw new Error('controller down');
        },
        release: async () => {},
      }),
    })
  ).toEqual({ kind: 'unavailable' });
  expect(
    await acquireCheckoutPermit({
      getByName: () => ({
        acquire: async () => ({ ok: false as const, retryAfterSeconds: 7 }),
        release: async () => {},
      }),
    })
  ).toEqual({ kind: 'busy', retryAfterSeconds: 7 });
});

// --------------------------------------------------------------- route

let db: D1Database, dispose: () => Promise<void>;
const INTENT = '123e4567-e89b-42d3-a456-426614174200';

beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 10, priceCents: 2000 });
  vi.clearAllMocks();
  provider.createCheckout.mockResolvedValue({
    sessionId: 'cs_admission',
    url: 'https://stripe.test/admission',
  });
  provider.createCoupon.mockResolvedValue('coupon_admission');
  provider.createCheckoutSession.mockResolvedValue({
    sessionId: 'cs_admission',
    url: 'https://stripe.test/admission',
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await dispose();
});

const GUEST_COOKIE = 'guest_checkout=admission-test-token';

async function post(intentId: string, admission?: unknown) {
  const quoted = await quoteOrder(db, {
    email: 'guest@example.invalid',
    lines: [{ sku: 'TEE-1', qty: 1 }],
    shippingCountry: 'US',
    shippingRateId: 'test-rate',
  });
  return handleCheckoutRequest(
    new Request('http://localhost:8799/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: GUEST_COOKIE },
      body: JSON.stringify({
        intentId,
        quoteRevision: quoted.configRevision,
        confirmedQuote: quoted,
        email: 'guest@example.invalid',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      }),
    }),
    { DB: db, ...(admission !== undefined ? { CHECKOUT_ADMISSION: admission } : {}) } as never
  );
}

async function count(table: string) {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
}

it('busy admission returns 429 CHECKOUT_BUSY and creates nothing', async () => {
  const fake = fakeAdmissionNamespace({
    admission_starts_per_second: 1,
    admission_burst: 1,
    admission_max_active: 1,
  });
  // Drain the only token/permit and hold it, so the budget is full.
  expect(fake.admission.acquire(Date.now()).ok).toBe(true);
  const response = await post(INTENT, fake.namespace);
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({ code: 'CHECKOUT_BUSY' });
  expect(Number(response.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
  expect(await count('orders')).toBe(0);
  expect(await count('checkout_intents')).toBe(0);
  expect(await count('reservations')).toBe(0);
  expect(provider.createCheckoutSession).not.toHaveBeenCalled();
  expect(provider.createCheckout).not.toHaveBeenCalled();
});

it('missing admission controller returns 503 CHECKOUT_UNAVAILABLE and creates nothing', async () => {
  const response = await post(INTENT);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'CHECKOUT_UNAVAILABLE' });
  expect(await count('orders')).toBe(0);
  expect(provider.createCheckoutSession).not.toHaveBeenCalled();
});

it('replays of an existing intent never consume admission capacity', async () => {
  const fake = fakeAdmissionNamespace({
    admission_starts_per_second: 100,
    admission_burst: 200,
    admission_max_active: 200,
  });
  const first = await post(INTENT, fake.namespace);
  expect(first.status).toBe(200);
  const cookie = GUEST_COOKIE;
  // Exhaust the controller completely, then replay: the existing
  // intent must still resolve from its durable state.
  const exhausted = fakeAdmissionNamespace({
    admission_starts_per_second: 1,
    admission_burst: 1,
    admission_max_active: 1,
  });
  expect(exhausted.admission.acquire(Date.now()).ok).toBe(true);
  const replay = await handleCheckoutRequest(
    new Request('http://localhost:8799/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        intentId: INTENT,
        email: 'guest@example.invalid',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      }),
    }),
    { DB: db, CHECKOUT_ADMISSION: exhausted.namespace } as never
  );
  expect(replay.status).toBe(200);
  expect((await replay.json()).checkoutUrl).toBe('https://stripe.test/admission');
  expect(provider.createCheckoutSession).toHaveBeenCalledTimes(1);
});

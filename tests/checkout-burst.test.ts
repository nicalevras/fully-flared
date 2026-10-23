import { quoteOrder } from '../web/src/server/checkout';
import { expect, it, vi } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { handleCheckoutRequest } from '../web/src/routes/api/checkout';
import { fakeAdmissionNamespace } from './helpers/admission';
import { reconcileCheckoutIntents } from '../web/src/server/checkout-intents';
import { fixtureShippingAddress, reviewSession } from './helpers/checkout-review';
import { sha256Hex } from '../web/src/lib/hash';

vi.mock('../web/src/server/session', () => ({ getSessionUser: async () => null }));
vi.mock('../web/src/server/turnstile', () => ({ verifyTurnstile: async () => true }));

const provider = {
  createCheckout: vi.fn(),
  createCoupon: vi.fn(),
  createCheckoutSession: vi.fn(),
  createCheckoutCustomer: vi.fn(async () => 'cus_fixture'),
  retrieveCheckoutSession: vi.fn(),
  async verifyWebhook(payload: string) {
    const event = JSON.parse(payload);
    return { ...event, data: event.data.object };
  },
  refund: vi.fn(async () => ({ id: 're_x', status: 'pending' })),
};
vi.mock('../web/src/server/payments', () => ({ getStripeProvider: () => provider }));

// Phase 5 burst evidence: 1,000 checkout arrivals against the default
// admission budgets (5 starts/s, burst 10, 10 active) with a stubbed
// provider. Admitted work completes exactly once — one order, one
// reservation, one attached provider session each — whether it
// finishes inline (200) or parks under write contention and is
// completed by the recovery sweep (202). Everything admission denies
// is a clean, side-effect-free 429.
it(
  '1,000 arrivals: admitted complete exactly once, the rest are clean 429s',
  { timeout: 600_000 },
  async () => {
    const { db, dispose } = await createTestDb();
    try {
      await seedProduct(db, { onHand: 5000, priceCents: 2000 });
      const carts = await Promise.all(
        Array.from({ length: 1000 }, async () => {
          const id = crypto.randomUUID(),
            token = crypto.randomUUID();
          return { id, token, hash: await sha256Hex(token) };
        })
      );
      const cartJson = JSON.stringify(carts);
      await db.batch([
        db
          .prepare(
            `INSERT INTO carts(id,token_hash,status,expires_at,created_at,updated_at)
          SELECT json_extract(value,'$.id'),json_extract(value,'$.hash'),'open','2999-01-01',?,? FROM json_each(?)`
          )
          .bind(new Date().toISOString(), new Date().toISOString(), cartJson),
        db
          .prepare(
            `INSERT INTO cart_items(id,cart_id,sku,qty,unit_price_cents)
          SELECT json_extract(value,'$.id'),json_extract(value,'$.id'),'TEE-1',1,2000 FROM json_each(?)`
          )
          .bind(cartJson),
      ]);
      provider.retrieveCheckoutSession.mockImplementation((id: string) => reviewSession(db, id));
      // One session per operation identity, stable across retries of
      // the same intent (as Stripe's idempotency keys guarantee); a
      // constant id would collide on the stripe_session_id unique
      // constraint and park every intent after the first.
      const sessionFor = (req: { attemptId: string }) => ({
        sessionId: `cs_${req.attemptId}`,
        url: `https://stripe.test/${req.attemptId}`,
      });
      provider.createCheckout.mockImplementation(async (req: { attemptId: string }) =>
        sessionFor(req)
      );
      provider.createCoupon.mockResolvedValue('coupon_burst');
      provider.createCheckoutSession.mockImplementation(async (req: { attemptId: string }) =>
        sessionFor(req)
      );
      const admission = fakeAdmissionNamespace();
      const env = { DB: db, CHECKOUT_ADMISSION: admission.namespace } as never;

      const quoted = await quoteOrder(db, {
        email: 'burst@example.invalid',
        lines: [{ sku: 'TEE-1', qty: 1 }],
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
      });
      const post = (i: number) =>
        handleCheckoutRequest(
          new Request('http://localhost:8799/api/checkout', {
            method: 'POST',
            // Each arrival is a distinct guest shopper whose browser
            // already bootstrapped its own capability cookie.
            headers: {
              'content-type': 'application/json',
              cookie: `guest_checkout=burst-${i}; cart=${carts[i]!.id}.${carts[i]!.token}`,
            },
            body: JSON.stringify({
              intentId: crypto.randomUUID(),
              cartId: carts[i]!.id,
              cartRevision: 1,
              shippingAddress: fixtureShippingAddress,
              quoteRevision: quoted.configRevision,
              confirmedQuote: quoted,
              email: `burst-${i}@example.invalid`,
              shippingCountry: 'US',
              shippingRateId: 'test-rate',
              lines: [{ sku: 'TEE-1', qty: 1 }],
            }),
          }),
          env
        );

      const started = Date.now();
      let ready = 0;
      let pending = 0;
      let busy = 0;
      let other = 0;
      for (let wave = 0; wave < 40; wave++) {
        const responses = await Promise.all(
          Array.from({ length: 25 }, (_, j) => post(wave * 25 + j))
        );
        for (const r of responses) {
          // 200 = session ready now; 202 = admitted but parked for
          // recovery under write contention (durable, same operation
          // identity); 429 = admission denied with zero side effects.
          if (r.status === 200) ready++;
          else if (r.status === 202) pending++;
          else if (r.status === 429) busy++;
          else other++;
          await r.body?.cancel().catch(() => undefined);
        }
      }
      const elapsedMs = Date.now() - started;
      const admitted = ready + pending;

      const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
      const orders = await count('SELECT COUNT(*) AS n FROM orders');
      const reservations = await count('SELECT COUNT(*) AS n FROM reservations');
      const reservedUnits = (
        await db
          .prepare("SELECT reserved FROM stock WHERE sku = 'TEE-1'")
          .first<{ reserved: number }>()
      )?.reserved;

      // Recovery completes every parked initiation with the same
      // provider operation identity: still exactly one order, one
      // reservation and one attached session per admitted start.
      // Parked rows carry a 60 s reconcile delay; fast-forward it to
      // simulate the clock the cron sweep would eventually see.
      await db
        .prepare(
          "UPDATE checkout_intents SET next_reconcile_at = '2000-01-01T00:00:00.000Z' WHERE state = 'reconciliation_required'"
        )
        .run();
      for (let pass = 0; pass < 10; pass++) {
        const advanced = await reconcileCheckoutIntents(
          db,
          provider as never,
          1000,
          fakeAdmissionNamespace({
            admission_starts_per_second: 100,
            admission_burst: 200,
            admission_max_active: 200,
          }).namespace
        );
        if (!advanced) break;
      }
      const readyIntents = await count(
        "SELECT COUNT(*) AS n FROM checkout_intents WHERE state = 'ready'"
      );
      const attachedOrders = await count(
        'SELECT COUNT(*) AS n FROM orders WHERE stripe_checkout_session_id IS NOT NULL'
      );
      process.stdout.write(
        `BURST arrivals=1000 admitted=${admitted} readyNow=${ready} parkedThenRecovered=${pending} rejected=${busy} other=${other} elapsedMs=${elapsedMs} orders=${orders} providerSessionCalls=${provider.createCheckoutSession.mock.calls.length}\n`
      );

      expect(other).toBe(0);
      expect(admitted + busy).toBe(1000);
      expect(admitted).toBeGreaterThanOrEqual(10); // at least the burst allowance gets in
      expect(busy).toBeGreaterThan(0);
      expect(orders).toBe(admitted);
      expect(reservations).toBe(0);
      expect(reservedUnits).toBe(0);
      expect(readyIntents).toBe(admitted);
      expect(attachedOrders).toBe(admitted);
      expect(provider.createCheckoutSession.mock.calls.length).toBeGreaterThanOrEqual(admitted);
    } finally {
      await dispose();
    }
  }
);

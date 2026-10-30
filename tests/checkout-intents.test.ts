import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { handleCheckoutRequest } from '../web/src/routes/api/checkout';
import { handleGuestBootstrapRequest } from '../web/src/routes/api/checkout/guest-session';
import { quoteOrder } from '../web/src/server/checkout';
import { heldOrder } from './helpers/pending-intent';
import {
  loadIntent,
  reconcileCheckoutIntents,
  runIntentOperation,
} from '../web/src/server/checkout-intents';
import { deleteAccountAtomically } from '../web/src/server/account-deletion';
import { fakeAdmissionNamespace } from './helpers/admission';
import { at, present } from './helpers/fixtures';
import { responseJson, z } from './helpers/json';
import type { ProviderCall } from './helpers/payments';
import type { PaymentProvider } from '../web/src/server/payments';
import { ensureCart, addCartLine, cartIdentity, type CartCreds } from '../web/src/server/cart';
import {
  checkoutInputKey,
  classifyCheckoutResponse,
  ensureGuestBootstrap,
  getCheckoutIntent,
  resetCheckoutIntent,
} from '../web/src/lib/checkout-intent';

vi.mock('../web/src/server/session', () => ({ getSessionUser: async () => null }));
vi.mock('../web/src/server/turnstile', () => ({ verifyTurnstile: async () => true }));

const provider = {
  createCheckout: vi.fn<ProviderCall<'createCheckout'>>(),
  createCoupon: vi.fn<ProviderCall<'createCoupon'>>(),
  createCheckoutSession: vi.fn<ProviderCall<'createCheckoutSession'>>(),
  createCheckoutCustomer: vi.fn<ProviderCall<'createCheckoutCustomer'>>(async () => 'cus_fixture'),
  retrieveCheckoutSession: vi.fn<ProviderCall<'retrieveCheckoutSession'>>(),
  async verifyWebhook(payload: string) {
    const event = JSON.parse(payload);
    return { ...event, data: event.data.object };
  },
  refund: vi.fn<ProviderCall<'refund'>>(async () => ({ id: 're_x', status: 'pending' })),
} satisfies PaymentProvider;
vi.mock('../web/src/server/payments', () => ({ getStripeProvider: () => provider }));

let db: D1Database, dispose: () => Promise<void>;
let admission: ReturnType<typeof fakeAdmissionNamespace>;
let guestCookie: string | undefined;
let cart: CartCreds;
const shippingAddress = {
  name: 'Fixture',
  line1: '1 Test Street',
  city: 'New York',
  state: 'NY',
  postalCode: '10001',
  country: 'US',
};
const INTENT = '123e4567-e89b-42d3-a456-426614174100';
const stateBody = z.object({ state: z.string() });
const codeBody = z.object({ code: z.string() });

beforeEach(async () => {
  guestCookie = undefined;
  ({ db, dispose } = await createTestDb());
  admission = fakeAdmissionNamespace({
    admission_starts_per_second: 100,
    admission_burst: 200,
    admission_max_active: 200,
  });
  await seedProduct(db, { onHand: 10, priceCents: 2000 });
  cart = (await ensureCart(db, null)).creds;
  await addCartLine(db, cart, 'TEE-1', 1);
  await db
    .prepare(
      `INSERT INTO discounts (id, code, type, value, status, usage_per_customer, created_at) VALUES ('d1', 'SAVE10', 'percentage', 10, 'active', 1, ?)`
    )
    .bind(new Date().toISOString())
    .run();
  vi.clearAllMocks();
  provider.createCheckout.mockResolvedValue({
    sessionId: 'cs_intent',
    url: 'https://stripe.test/intent',
  });
  provider.createCoupon.mockResolvedValue('coupon_intent');
  provider.createCheckoutSession.mockResolvedValue({
    sessionId: 'cs_intent',
    url: 'https://stripe.test/intent',
  });
  provider.retrieveCheckoutSession.mockImplementation(async (id: string) => {
    const row = await db
      .prepare(
        'SELECT order_id,id,provider_payload_json FROM checkout_intents WHERE stripe_session_id=?'
      )
      .bind(id)
      .first<{ order_id: string; id: string; provider_payload_json: string }>();
    if (!row) return null;
    const order = present(
      await db.prepare('SELECT * FROM orders WHERE id=?').bind(row.order_id).first<{
        subtotal_cents: number;
        discount_cents: number;
        shipping_cents: number;
        total_cents: number;
      }>(),
      'the intent order'
    );
    return {
      id,
      status: 'open',
      url: 'https://stripe.test/intent',
      payment_status: 'unpaid',
      currency: 'usd',
      amount_total: order.total_cents,
      subtotalCents: order.subtotal_cents,
      discountCents: order.discount_cents,
      shippingCents: order.shipping_cents,
      taxCents: 0,
      payment_intent: null,
      metadata: { order_id: row.order_id, attempt_id: row.id },
    };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await dispose();
});

function bootstrap(cookie?: string) {
  return handleGuestBootstrapRequest(
    new Request('http://localhost:8799/api/checkout/guest-session', {
      method: 'POST',
      headers: { ...(cookie ? { cookie } : {}) },
    }),
    { DB: db }
  );
}

async function bootstrapCookie(): Promise<string> {
  const res = await bootstrap();
  expect(res.status).toBe(204);
  const setCookie = res.headers.get('set-cookie') ?? '';
  expect(setCookie.startsWith('guest_checkout=')).toBe(true);
  return at(setCookie.split(';'), 0);
}

async function post(
  intentId: string,
  opts: {
    cookie?: string | undefined;
    qty?: number;
    code?: string;
    confirmedQuote?: {
      subtotalCents: number;
      discountCents: number;
      shippingCents: number;
      totalCents: number;
    };
  } = {}
) {
  // One shared browser capability for the whole test, established by
  // bootstrap before any checkout creates commerce state.
  guestCookie ??= await bootstrapCookie();
  const quoted = await quoteOrder(db, {
    email: 'guest@example.invalid',
    lines: [{ sku: 'TEE-1', qty: opts.qty ?? 1 }],
    shippingCountry: 'US',
    shippingRateId: 'test-rate',
    discountCode: opts.code,
  });
  return handleCheckoutRequest(
    new Request('http://localhost:8799/api/checkout', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${opts.cookie ?? guestCookie}; cart=${cart.id}.${cart.token}`,
      },
      body: JSON.stringify({
        intentId,
        cartId: cart.id,
        cartRevision: present(await cartIdentity(db, cart)).revision,
        shippingAddress,
        email: 'guest@example.invalid',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [{ sku: 'TEE-1', qty: opts.qty ?? 1 }],
        ...(opts.code ? { discountCode: opts.code } : {}),
        quoteRevision: quoted.configRevision,
        confirmedQuote: opts.confirmedQuote ?? quoted,
      }),
    }),
    { DB: db, CHECKOUT_ADMISSION: admission.namespace } as never
  );
}

/** A checkout request with no capability cookie at all. */
function postWithoutBootstrap(intentId: string) {
  return handleCheckoutRequest(
    new Request('http://localhost:8799/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `cart=${cart.id}.${cart.token}` },
      body: JSON.stringify({
        intentId,
        cartId: cart.id,
        cartRevision: 1,
        shippingAddress,
        email: 'guest@example.invalid',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      }),
    }),
    { DB: db, CHECKOUT_ADMISSION: admission.namespace } as never
  );
}

async function count(table: string) {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
}
async function stock() {
  return db.prepare("SELECT on_hand, reserved FROM stock WHERE sku='TEE-1'").first();
}

it('duplicate preparations yield one order, no reservation and one session operation', async () => {
  const first = await post(INTENT);
  expect(first.status).toBe(200);
  const body = await responseJson(first, stateBody);
  expect(body.state).toBe('review_ready');
  const cookie = guestCookie;
  expect(cookie).toBeTruthy();

  const second = await post(INTENT, { cookie });
  expect(second.status).toBe(200);
  expect((await responseJson(second, stateBody)).state).toBe('review_ready');
  expect(provider.createCheckoutSession).toHaveBeenCalledTimes(1);
  expect(await count('orders')).toBe(1);
  expect(await count('checkout_intents')).toBe(1);
  expect(await count('reservations')).toBe(0);
  expect(await stock()).toEqual({ on_hand: 10, reserved: 0 });
});

it('bootstrap mints an HttpOnly capability cookie and creates no commerce state', async () => {
  const res = await bootstrap();
  expect(res.status).toBe(204);
  const guest = res.headers.get('set-cookie') ?? '';
  expect(guest.startsWith('guest_checkout=')).toBe(true);
  expect(guest).toContain('HttpOnly');
  expect(guest).toContain('Path=/');
  expect(guest).toContain('SameSite=Lax');
  // Bootstrap alone creates nothing: no intent, no order, no provider call.
  expect(await count('checkout_intents')).toBe(0);
  expect(await count('orders')).toBe(0);
  expect(provider.createCheckoutSession).not.toHaveBeenCalled();

  // The checkout response clears the cart cookies but never mints or
  // clears the capability cookie — bootstrap owns it.
  const first = await post(INTENT);
  expect(first.status).toBe(200);
  const cookies = first.headers.getSetCookie();
  expect(cookies.some((c) => c.startsWith('cart=') && c.includes('Max-Age=0'))).toBe(false);
  expect(cookies.some((c) => c.startsWith('guest_checkout='))).toBe(false);
});

it('bootstrap reuses an existing capability and never rotates ownership mid-checkout', async () => {
  const cookie = await bootstrapCookie();
  // A checkout is created between the two bootstrap responses.
  const created = await post(INTENT, { cookie });
  expect(created.status).toBe(200);
  // A reload / second tab bootstrapping again presents the shared
  // cookie: 204 with no Set-Cookie, so ownership is not rotated.
  const again = await bootstrap(cookie);
  expect(again.status).toBe(204);
  expect(again.headers.get('set-cookie')).toBeNull();
  // The original owner still replays its ready checkout.
  const retry = await post(INTENT, { cookie });
  expect(retry.status).toBe(200);
  expect((await responseJson(retry, stateBody)).state).toBe('review_ready');
  expect(await count('orders')).toBe(1);
});

it('guest checkout without bootstrap is 428 and creates nothing', async () => {
  const res = await postWithoutBootstrap(INTENT);
  expect(res.status).toBe(428);
  expect((await responseJson(res, codeBody)).code).toBe('GUEST_BOOTSTRAP_REQUIRED');
  expect(await count('checkout_intents')).toBe(0);
  expect(await count('orders')).toBe(0);
  expect(await count('reservations')).toBe(0);
  expect(provider.createCheckoutSession).not.toHaveBeenCalled();
});

it('unproven ownership reveals nothing; changed fingerprint conflicts for the owner', async () => {
  const first = await post(INTENT);
  expect(first.status).toBe(200);
  const cookie = guestCookie;

  const stranger = await post(INTENT, { cookie: 'guest_checkout=other-token', qty: 2 });
  expect(stranger.status).toBe(404);
  expect(JSON.stringify(await stranger.json())).not.toContain('stripe.test');

  const changed = await post(INTENT, { cookie, qty: 2 });
  expect(changed.status).toBe(409);
  expect(await count('orders')).toBe(1);
});

it('concurrent duplicates with the same capability produce one order', async () => {
  const cookie = 'guest_checkout=shared-token';
  const [a, b] = await Promise.all([post(INTENT, { cookie }), post(INTENT, { cookie })]);
  // One wins ready; the concurrent duplicate reports pending (never a
  // second provider call), and its retry replays the ready session.
  expect([a.status, b.status].sort()).toEqual([200, 202]);
  const retry = await post(INTENT, { cookie });
  expect(retry.status).toBe(200);
  expect(await count('orders')).toBe(1);
  expect(await count('checkout_intents')).toBe(1);
  expect(provider.createCheckoutSession).toHaveBeenCalledTimes(1);
});

it('ambiguous provider failure parks in reconciliation and recovers with the same operation', async () => {
  provider.createCheckoutSession.mockRejectedValueOnce(new Error('socket timeout'));
  const first = await post(INTENT);
  expect(first.status).toBe(202);
  const intent = await loadIntent(db, INTENT);
  expect(intent?.state).toBe('reconciliation_required');
  expect(intent?.failure_code).toBe('provider_uncertain');
  expect(await stock()).toEqual({ on_hand: 10, reserved: 0 });

  await db
    .prepare("UPDATE checkout_intents SET next_reconcile_at='2000-01-01' WHERE id=?")
    .bind(INTENT)
    .run();
  expect(await reconcileCheckoutIntents(db, provider, 10, admission.namespace)).toBe(1);
  const recovered = await loadIntent(db, INTENT);
  expect(recovered?.state).toBe('ready');
  expect(recovered?.stripe_session_id).toBe('cs_intent');
  const order = await db
    .prepare('SELECT stripe_checkout_session_id FROM orders WHERE id=?')
    .bind(recovered?.order_id)
    .first();
  expect(order?.stripe_checkout_session_id).toBe('cs_intent');
});

it('definite provider rejection cancels and releases the hold', async () => {
  provider.createCheckoutSession.mockRejectedValueOnce(
    Object.assign(new Error('invalid request'), { statusCode: 400 })
  );
  const res = await post(INTENT);
  expect(res.status).toBe(409);
  const intent = await loadIntent(db, INTENT);
  expect(intent?.state).toBe('canceled');
  expect(await stock()).toEqual({ on_hand: 10, reserved: 0 });
  const order = await db.prepare('SELECT status FROM orders').first<{ status: string }>();
  expect(order?.status).toBe('canceled');
});

it('coupon result is stored before session creation and not recreated on recovery', async () => {
  provider.createCheckoutSession.mockRejectedValueOnce(new Error('connection reset'));
  const first = await post(INTENT, { code: 'SAVE10' });
  expect(first.status).toBe(202);
  expect(provider.createCoupon).toHaveBeenCalledTimes(1);
  expect((await loadIntent(db, INTENT))?.stripe_coupon_id).toBe('coupon_intent');

  await db
    .prepare("UPDATE checkout_intents SET next_reconcile_at='2000-01-01' WHERE id=?")
    .bind(INTENT)
    .run();
  await reconcileCheckoutIntents(db, provider, 10, admission.namespace);
  expect(provider.createCoupon).toHaveBeenCalledTimes(1);
  expect(provider.createCheckoutSession).toHaveBeenCalledTimes(2);
  expect(provider.createCheckoutSession).toHaveBeenLastCalledWith(
    expect.objectContaining({ discountCents: 200 }),
    'coupon_intent',
    expect.objectContaining({ timeoutMs: expect.any(Number) })
  );
  expect((await loadIntent(db, INTENT))?.state).toBe('ready');
});

it('an active claim blocks a second worker without calling Stripe', async () => {
  await post(INTENT);
  await db
    .prepare(
      "UPDATE checkout_intents SET state='session_creating', claim_token='held', claim_expires_at='2999-01-01' WHERE id=?"
    )
    .bind(INTENT)
    .run();
  provider.createCheckoutSession.mockClear();
  expect(await runIntentOperation(db, provider, INTENT)).toEqual({
    status: 'pending',
  });
  expect(provider.createCheckoutSession).not.toHaveBeenCalled();
});

it('an expired claim on a crashed session_creating intent recovers exactly once', async () => {
  await post(INTENT);
  // Simulate a crash before attachment: no session identifier was committed.
  await db.batch([
    db
      .prepare('UPDATE orders SET stripe_checkout_session_id=NULL WHERE checkout_intent_id=?')
      .bind(INTENT),
    db
      .prepare(
        "UPDATE checkout_intents SET stripe_session_id=NULL,checkout_url=NULL,state='session_creating',claim_token='dead-worker',claim_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?"
      )
      .bind(INTENT),
  ]);
  provider.createCheckoutSession.mockClear();
  expect(await runIntentOperation(db, provider, INTENT)).toEqual({
    status: 'ready',
    checkoutUrl: 'https://stripe.test/intent',
  });
  expect(provider.createCheckoutSession).toHaveBeenCalledTimes(1);
  expect(await loadIntent(db, INTENT)).toMatchObject({
    state: 'ready',
    stripe_session_id: 'cs_intent',
  });
  // A second worker resuming the same intent does not call Stripe again.
  expect(await runIntentOperation(db, provider, INTENT)).toEqual({
    status: 'ready',
    checkoutUrl: 'https://stripe.test/intent',
  });
  expect(provider.createCheckoutSession).toHaveBeenCalledTimes(1);
});

it('account deletion cancels open checkouts and releases their holds', async () => {
  await db
    .prepare(
      "INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES('cust2','Cust','cust2@example.invalid','customer',0,0)"
    )
    .run();
  const created = await heldOrder(
    db,
    {
      email: 'cust2@example.invalid',
      userId: 'cust2',
      lines: [{ sku: 'TEE-1', qty: 1 }],
      shippingRateId: 'test-rate',
      shippingCountry: 'US',
    },
    {
      id: INTENT,
      ownerType: 'account',
      userId: 'cust2',
      guestCapabilityHash: null,
      fingerprint: 'fp',
      sessionExpiresAt: '2999-01-01',
      payloadFor: async () => ({ email: 'cust2@example.invalid' }),
    }
  );
  expect(await stock()).toEqual({ on_hand: 10, reserved: 1 });
  await deleteAccountAtomically(db, 'cust2');
  expect(await stock()).toEqual({ on_hand: 10, reserved: 0 });
  const order = await db
    .prepare('SELECT status FROM orders WHERE id=?')
    .bind(created.orderId)
    .first<{ status: string }>();
  expect(order?.status).toBe('canceled');
  expect((await loadIntent(db, INTENT))?.state).toBe('canceled');
});

it('a 409 conflict stays uncertain without unpaid stock holds', async () => {
  provider.createCheckoutSession.mockRejectedValue(
    Object.assign(new Error('conflict'), { statusCode: 409 })
  );
  const res = await post(INTENT);
  expect(res.status).toBe(202);
  const intent = await loadIntent(db, INTENT);
  expect(intent?.state).toBe('reconciliation_required');
  expect(intent?.failure_code).toBe('provider_uncertain');
  expect(await stock()).toEqual({ on_hand: 10, reserved: 0 });
});

it('a stale worker cannot cancel after losing its claim', async () => {
  provider.createCheckoutSession.mockImplementation(async () => {
    // A newer worker takes over the claim while this call is in flight.
    await db
      .prepare(
        "UPDATE checkout_intents SET claim_token = 'newer', fencing = fencing + 1 WHERE id = ?"
      )
      .bind(INTENT)
      .run();
    throw Object.assign(new Error('invalid'), { statusCode: 400 });
  });
  const res = await post(INTENT);
  expect(res.status).toBe(202);
  const intent = await loadIntent(db, INTENT);
  expect(intent?.state).toBe('session_creating');
  expect(intent?.claim_token).toBe('newer');
  expect(await stock()).toEqual({ on_hand: 10, reserved: 0 });
});

it('existing-intent retries that reach the provider consume admission', async () => {
  provider.createCheckoutSession.mockRejectedValue(new Error('network down'));
  const first = await post(INTENT);
  expect(first.status).toBe(202);
  const cookie = guestCookie;
  expect(cookie).toBeTruthy();
  provider.createCheckoutSession.mockResolvedValue({
    sessionId: 'cs_intent',
    url: 'https://stripe.test/intent',
  });
  provider.createCheckoutSession.mockClear();
  // Saturate admission with an unrelated holder.
  const tight = fakeAdmissionNamespace({
    admission_starts_per_second: 1,
    admission_burst: 1,
    admission_max_active: 1,
  });
  expect((await tight.namespace.getByName('store').acquire()).ok).toBe(true);
  admission = tight;
  const busy = await post(INTENT, { cookie });
  expect(busy.status).toBe(429);
  expect(busy.headers.get('Retry-After')).toBeTruthy();
  expect(provider.createCheckoutSession).not.toHaveBeenCalled();
});

it('an exhausted deadline parks the retry instead of calling the provider', async () => {
  provider.createCheckoutSession.mockRejectedValue(new Error('network down'));
  const first = await post(INTENT);
  expect(first.status).toBe(202);
  const cookie = guestCookie;
  provider.createCheckoutSession.mockResolvedValue({
    sessionId: 'cs_intent',
    url: 'https://stripe.test/intent',
  });
  provider.createCheckoutSession.mockClear();
  const res = await handleCheckoutRequest(
    new Request('http://localhost:8799/api/checkout', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${cookie}; cart=${cart.id}.${cart.token}`,
      },
      body: JSON.stringify({
        intentId: INTENT,
        cartId: cart.id,
        cartRevision: present(await cartIdentity(db, cart)).revision,
        shippingAddress,
        quoteRevision: (
          await quoteOrder(db, {
            email: 'guest@example.invalid',
            shippingCountry: 'US',
            shippingRateId: 'test-rate',
            lines: [{ sku: 'TEE-1', qty: 1 }],
          })
        ).configRevision,
        confirmedQuote: await quoteOrder(db, {
          email: 'guest@example.invalid',
          shippingCountry: 'US',
          shippingRateId: 'test-rate',
          lines: [{ sku: 'TEE-1', qty: 1 }],
        }),
        email: 'guest@example.invalid',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      }),
    }),
    { DB: db, CHECKOUT_ADMISSION: admission.namespace } as never,
    { deadlineMs: Date.now() - 1 }
  );
  expect(res.status).toBe(202);
  expect(provider.createCheckoutSession).not.toHaveBeenCalled();
  expect((await loadIntent(db, INTENT))?.failure_code).toBe('deadline_exceeded');
});

it('recovery retrieves a known session instead of creating a new one', async () => {
  provider.createCheckoutSession.mockRejectedValue(new Error('network down'));
  await post(INTENT);
  await db
    .prepare(
      "UPDATE checkout_intents SET stripe_session_id = 'cs_known', next_reconcile_at = NULL WHERE id = ?"
    )
    .bind(INTENT)
    .run();
  provider.createCheckoutSession.mockClear();
  provider.retrieveCheckoutSession.mockResolvedValue({
    id: 'cs_known',
    status: 'open',
    url: 'https://stripe.test/known',
    payment_status: 'unpaid',
    amount_total: 2000,
    currency: 'usd',
    payment_intent: null,
  });
  expect(await runIntentOperation(db, provider, INTENT)).toEqual({
    status: 'ready',
    checkoutUrl: 'https://stripe.test/known',
  });
  expect(provider.createCheckoutSession).not.toHaveBeenCalled();
  expect((await loadIntent(db, INTENT))?.checkout_url).toBe('https://stripe.test/known');
});

it('past the creation horizon an unresolved intent is preserved and alerted, never canceled', async () => {
  provider.createCheckoutSession.mockRejectedValue(new Error('network down'));
  await post(INTENT);
  await db
    .prepare(
      "UPDATE checkout_intents SET created_at = '2020-01-01T00:00:00.000Z', next_reconcile_at = NULL WHERE id = ?"
    )
    .bind(INTENT)
    .run();
  provider.createCheckoutSession.mockClear();
  expect(await runIntentOperation(db, provider, INTENT)).toEqual({ status: 'pending' });
  const intent = await loadIntent(db, INTENT);
  expect(intent?.state).toBe('reconciliation_required');
  expect(intent?.failure_code).toBe('provider_unresolved');
  expect(provider.createCheckoutSession).not.toHaveBeenCalled();
  expect(await stock()).toEqual({ on_hand: 10, reserved: 0 });
});

it('expired frozen parameters preserve unresolved intent without calling Stripe', async () => {
  await post(INTENT);
  await db
    .prepare(
      "UPDATE checkout_intents SET state='reconciliation_required', next_reconcile_at=NULL, session_expires_at='2000-01-01' WHERE id=?"
    )
    .bind(INTENT)
    .run();
  provider.createCheckoutSession.mockClear();
  provider.retrieveCheckoutSession.mockResolvedValueOnce({
    id: 'cs_intent',
    status: 'expired',
    url: null,
    payment_status: 'unpaid',
    amount_total: 2000,
    currency: 'usd',
    payment_intent: null,
  });
  expect(await runIntentOperation(db, provider, INTENT)).toEqual({
    status: 'pending',
  });
  expect(provider.createCheckoutSession).not.toHaveBeenCalled();
  expect((await loadIntent(db, INTENT))?.state).toBe('reconciliation_required');
});

async function makeAccountCheckout(userId: string, role: string, email: string) {
  await db
    .prepare('INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES(?,?,?, ?,0,0)')
    .bind(userId, 'Cust', email, role)
    .run();
  return heldOrder(
    db,
    {
      email,
      userId,
      lines: [{ sku: 'TEE-1', qty: 1 }],
      shippingRateId: 'test-rate',
      shippingCountry: 'US',
    },
    {
      id: INTENT,
      ownerType: 'account',
      userId,
      guestCapabilityHash: null,
      fingerprint: 'fp',
      sessionExpiresAt: '2999-01-01',
      payloadFor: async () => ({ email }),
    }
  );
}

async function expectCheckoutUntouched(orderId: string, userId: string) {
  const order = await db
    .prepare('SELECT status, payment_status, customer_email, user_id FROM orders WHERE id=?')
    .bind(orderId)
    .first<{ status: string; payment_status: string; customer_email: string; user_id: string }>();
  expect(order).toMatchObject({
    status: 'pending_payment',
    payment_status: 'unpaid',
    user_id: userId,
  });
  expect(order?.customer_email).not.toBe('deleted@invalid');
  expect(await stock()).toEqual({ on_hand: 10, reserved: 1 });
  const intent = await loadIntent(db, INTENT);
  expect(intent?.state).toBe('reserved');
  expect(intent?.user_id).toBe(userId);
  expect(await db.prepare('SELECT id FROM user WHERE id=?').bind(userId).first()).not.toBeNull();
}

it('guard-rejected deletion leaves the open checkout, holds and intent untouched', async () => {
  const created = await makeAccountCheckout('owner3', 'owner', 'owner3@example.invalid');
  expect(await stock()).toEqual({ on_hand: 10, reserved: 1 });
  await expect(deleteAccountAtomically(db, 'owner3')).rejects.toMatchObject({ status: 409 });
  await expectCheckoutUntouched(created.orderId, 'owner3');
});

it('promotion racing deletion leaves the open checkout untouched', async () => {
  const created = await makeAccountCheckout('cust4', 'customer', 'cust4@example.invalid');
  let promoted = false;
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (stmts: D1PreparedStatement[]) => {
          if (!promoted) {
            promoted = true;
            await db.prepare("UPDATE user SET role='owner' WHERE id='cust4'").run();
          }
          return db.batch(stmts);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(deleteAccountAtomically(wrapped, 'cust4')).rejects.toMatchObject({
    status: 409,
  });
  expect(
    (await db.prepare("SELECT role FROM user WHERE id='cust4'").first<{ role: string }>())?.role
  ).toBe('owner');
  await expectCheckoutUntouched(created.orderId, 'cust4');
});

it('a late failure rolls back checkout cancellation; retry deletes atomically', async () => {
  const created = await makeAccountCheckout('cust5', 'customer', 'cust5@example.invalid');
  await db
    .prepare(
      "CREATE TRIGGER fail_cust5_delete BEFORE DELETE ON user WHEN OLD.id='cust5' BEGIN SELECT RAISE(ABORT,'fixture deletion failure'); END"
    )
    .run();
  await expect(deleteAccountAtomically(db, 'cust5')).rejects.toThrow(
    'Account deletion failed. Please try again.'
  );
  // Cancellation statements ran inside the batch but rolled back.
  await expectCheckoutUntouched(created.orderId, 'cust5');

  await db.prepare('DROP TRIGGER fail_cust5_delete').run();
  await deleteAccountAtomically(db, 'cust5');
  expect(await db.prepare("SELECT id FROM user WHERE id='cust5'").first()).toBeNull();
  const order = await db
    .prepare('SELECT status, user_id FROM orders WHERE id=?')
    .bind(created.orderId)
    .first<{ status: string; user_id: string | null }>();
  expect(order).toEqual({ status: 'canceled', user_id: null });
  expect(await stock()).toEqual({ on_hand: 10, reserved: 0 });
  const intent = await loadIntent(db, INTENT);
  expect(intent?.state).toBe('canceled');
  expect(intent?.provider_payload_json).toBe('{}');
});

it('account deletion retires intent replay and scrubs the frozen payload', async () => {
  await db
    .prepare(
      "INSERT INTO user(id,name,email,role,created_at,updated_at) VALUES('cust','Cust','cust@example.invalid','customer',0,0)"
    )
    .run();
  const created = await heldOrder(
    db,
    {
      email: 'cust@example.invalid',
      userId: 'cust',
      lines: [{ sku: 'TEE-1', qty: 1 }],
      shippingRateId: 'test-rate',
      shippingCountry: 'US',
    },
    {
      id: INTENT,
      ownerType: 'account',
      userId: 'cust',
      guestCapabilityHash: null,
      fingerprint: 'fp',
      sessionExpiresAt: '2999-01-01',
      payloadFor: async () => ({ email: 'cust@example.invalid' }),
    }
  );
  expect(created.orderId).toBeTruthy();
  await deleteAccountAtomically(db, 'cust');
  const intent = await loadIntent(db, INTENT);
  expect(intent?.user_id).toBeNull();
  expect(intent?.guest_capability_hash).toBeNull();
  const raw = await db
    .prepare('SELECT provider_payload_json FROM checkout_intents WHERE id=?')
    .bind(INTENT)
    .first<{ provider_payload_json: string }>();
  expect(raw?.provider_payload_json).toBe('{}');
});

it('a submitted total that differs from the confirmed quote is rejected for requote', async () => {
  // Displayed/confirmed: $20.00 with no coupon. Submitted: an
  // unapplied coupon code changes the authoritative total to $18.00,
  // so the confirmed breakdown no longer matches and nothing is
  // created (the $100-displayed vs $109-submitted class of bug).
  const res = await post(INTENT, {
    code: 'SAVE10',
    confirmedQuote: { subtotalCents: 2000, discountCents: 0, shippingCents: 0, totalCents: 2000 },
  });
  expect(res.status).toBe(409);
  expect((await responseJson(res, codeBody)).code).toBe('STALE_QUOTE');
  expect(await count('orders')).toBe(0);
  expect(await count('checkout_intents')).toBe(0);
  expect(await stock()).toEqual({ on_hand: 10, reserved: 0 });
  expect(provider.createCheckoutSession).not.toHaveBeenCalled();
});

it('a submission matching its confirmed quote proceeds', async () => {
  const res = await post(INTENT, {
    code: 'SAVE10',
    confirmedQuote: { subtotalCents: 2000, discountCents: 200, shippingCents: 0, totalCents: 1800 },
  });
  expect(res.status).toBe(200);
  expect((await responseJson(res, stateBody)).state).toBe('review_ready');
  const order = await db.prepare('SELECT total_cents FROM orders').first<{ total_cents: number }>();
  expect(order?.total_cents).toBe(1800);
});

it('guest bootstrap is serialized by Web Locks and fails closed without them', async () => {
  // Without Web Locks: never call bootstrap, create nothing.
  let calls = 0;
  await expect(
    ensureGuestBootstrap(undefined, async () => {
      calls++;
    })
  ).resolves.toBe(false);
  expect(calls).toBe(0);

  // A fake exclusive lock: callbacks never overlap, even when both
  // tabs start before either bootstrap response arrives.
  let tail: Promise<void> = Promise.resolve();
  const locks = {
    request(_name: string, _opts: { mode: 'exclusive' }, cb: () => Promise<void>) {
      const run = tail.then(cb, cb);
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };
  let active = 0;
  let maxActive = 0;
  const bootstrapOnce = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
  };
  await Promise.all([
    ensureGuestBootstrap(locks, bootstrapOnce),
    ensureGuestBootstrap(locks, bootstrapOnce),
  ]);
  expect(maxActive).toBe(1);
});

it('client intent identity is reused until inputs change or it is reset', async () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const key = await checkoutInputKey({
    cartId: 'cart-1',
    cartRevision: 1,
    email: 'A@b.com',
    lines: [{ sku: 'TEE-1', qty: 1 }],
    shippingCountry: 'US',
    shippingRateId: 'test-rate',
  });
  // Only a digest is stored: no email anywhere in browser storage.
  const first = getCheckoutIntent(storage, key);
  const stored = [...store.values()].join(' ');
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(stored).toContain(key);
  expect(stored.toLowerCase()).not.toContain('a@b.com');
  expect(getCheckoutIntent(storage, key)).toEqual({ intentId: first.intentId, fresh: false });
  const changed = getCheckoutIntent(
    storage,
    await checkoutInputKey({
      cartId: 'cart-1',
      cartRevision: 1,
      email: 'a@b.com',
      lines: [{ sku: 'TEE-1', qty: 2 }],
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
    })
  );
  expect(changed.intentId).not.toBe(first.intentId);
  resetCheckoutIntent(storage);
  expect(getCheckoutIntent(storage, key).intentId).not.toBe(changed.intentId);
  expect(classifyCheckoutResponse(200, { checkoutUrl: 'https://x' })).toEqual({
    kind: 'redirect',
    url: 'https://x',
  });
  expect(classifyCheckoutResponse(202, { orderId: 'o1' })).toEqual({
    kind: 'pending',
    orderId: 'o1',
  });
  expect(classifyCheckoutResponse(409, { error: 'ended' })).toMatchObject({ terminal: true });
});

it('unavailable storage keeps one stable in-memory intent for unchanged inputs', async () => {
  const throwing = {
    getItem: () => {
      throw new Error('storage disabled');
    },
    setItem: () => {
      throw new Error('storage disabled');
    },
    removeItem: () => {
      throw new Error('storage disabled');
    },
  };
  const key = await checkoutInputKey({
    cartId: 'cart-1',
    cartRevision: 1,
    email: 'a@b.com',
    lines: [{ sku: 'TEE-1', qty: 1 }],
    shippingCountry: 'US',
    shippingRateId: 'test-rate',
  });
  const first = getCheckoutIntent(throwing, key);
  expect(getCheckoutIntent(throwing, key)).toEqual({ intentId: first.intentId, fresh: false });
  const other = await checkoutInputKey({
    cartId: 'cart-1',
    cartRevision: 1,
    email: 'a@b.com',
    lines: [{ sku: 'TEE-1', qty: 3 }],
    shippingCountry: 'US',
    shippingRateId: 'test-rate',
  });
  expect(getCheckoutIntent(throwing, other).intentId).not.toBe(first.intentId);
});

it('new HTTP checkout requires confirmed quote and creates no commerce state without it', async () => {
  guestCookie = await bootstrapCookie();
  const response = await handleCheckoutRequest(
    new Request('http://localhost:8799/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: guestCookie },
      body: JSON.stringify({
        intentId: INTENT,
        email: 'guest@example.invalid',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      }),
    }),
    { DB: db, CHECKOUT_ADMISSION: admission.namespace } as never
  );
  expect(response.status).toBe(400);
  expect(await count('orders')).toBe(0);
  expect(provider.createCheckoutSession).not.toHaveBeenCalled();
});
it('storage getter failure still reuses the in-memory intent', async () => {
  const { checkoutStorage } = await import('../web/src/lib/checkout-intent');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      throw new Error('blocked');
    },
  });
  try {
    resetCheckoutIntent(undefined);
    const first = getCheckoutIntent(checkoutStorage(), 'blocked-storage');
    expect(getCheckoutIntent(checkoutStorage(), 'blocked-storage')).toEqual({
      intentId: first.intentId,
      fresh: false,
    });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
    resetCheckoutIntent(undefined);
  }
});

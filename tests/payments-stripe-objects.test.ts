import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { handleCheckoutRequest } from '../web/src/routes/api/checkout';
import { handleGuestBootstrapRequest } from '../web/src/routes/api/checkout/guest-session';
import { quoteOrder } from '../web/src/server/checkout';
import { fakeAdmissionNamespace } from './helpers/admission';
import { at } from './helpers/fixtures';
import { ensureCart, addCartLine, cartIdentity, type CartCreds } from '../web/src/server/cart';

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

let db: D1Database, env: Cloudflare.Env, dispose: () => Promise<void>;
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

beforeEach(async () => {
  guestCookie = undefined;
  ({ db, env, dispose } = await createTestDb());
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
  provider.createCheckoutSession.mockImplementation(async (req: { attemptId: string }) => ({
    sessionId: `cs_${req.attemptId}`,
    url: 'https://stripe.test/intent',
  }));
  provider.retrieveCheckoutSession.mockImplementation(async (id: string) => {
    const row = await db
      .prepare(
        'SELECT o.id AS order_id, ci.id, o.subtotal_cents, o.discount_cents, o.shipping_cents, o.total_cents FROM checkout_intents ci JOIN orders o ON o.id=ci.order_id WHERE ci.stripe_session_id=?'
      )
      .bind(id)
      .first<{
        order_id: string;
        id: string;
        subtotal_cents: number;
        discount_cents: number;
        shipping_cents: number;
        total_cents: number;
      }>();
    if (!row) return null;
    return {
      id,
      status: 'open',
      url: 'https://stripe.test/intent',
      payment_status: 'unpaid',
      currency: 'usd',
      amount_total: row.total_cents,
      subtotalCents: row.subtotal_cents,
      discountCents: row.discount_cents,
      shippingCents: row.shipping_cents,
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
    cookie?: string;
    qty?: number;
    code?: string;
    email?: string;
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
    email: opts.email ?? 'guest@example.invalid',
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
        cartRevision: (await cartIdentity(db, cart))?.revision,
        shippingAddress,
        email: opts.email ?? 'guest@example.invalid',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [{ sku: 'TEE-1', qty: opts.qty ?? 1 }],
        ...(opts.code ? { discountCode: opts.code } : {}),
        quoteRevision: quoted.configRevision,
        confirmedQuote: opts.confirmedQuote ?? quoted,
      }),
    }),
    { ...env, CHECKOUT_ADMISSION: admission.namespace }
  );
}

const FIRST = '123e4567-e89b-42d3-a456-426614174101';
const SECOND = '123e4567-e89b-42d3-a456-426614174102';
const THIRD = '123e4567-e89b-42d3-a456-426614174103';

it('three attempts create one Customer', async () => {
  for (const intentId of [FIRST, SECOND, THIRD]) expect((await post(intentId)).status).toBe(200);

  expect(provider.createCheckoutCustomer).toHaveBeenCalledTimes(1);
  const customers = await db
    .prepare('SELECT DISTINCT stripe_customer_id AS id FROM checkout_intents')
    .all<{ id: string | null }>();
  expect(customers.results).toEqual([{ id: 'cus_fixture' }]);
});

it('a changed email on the same cart gets its own Customer', async () => {
  expect((await post(FIRST)).status).toBe(200);
  expect((await post(SECOND, { email: 'other@example.invalid' })).status).toBe(200);

  expect(provider.createCheckoutCustomer).toHaveBeenCalledTimes(2);
});

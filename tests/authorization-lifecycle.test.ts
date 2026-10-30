import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct, expectLedgerMatchesCounters } from './helpers/d1';
import { fakeAdmissionNamespace } from './helpers/admission';
import { fakeProvider } from './helpers/payments';
import { createPendingOrder, quoteOrder } from '../web/src/server/checkout';
import { loadIntent } from '../web/src/server/checkout-intents';
import { runAuthorizedCheckout } from '../web/src/server/authorized-checkout';
import { addCartLine, cartIdentity, ensureCart } from '../web/src/server/cart';
import type { PaymentProvider, PaymentIntentDetails } from '../web/src/server/payments';

let db: D1Database, dispose: () => Promise<void>;
let admission: ReturnType<typeof fakeAdmissionNamespace>;
const address = {
  name: 'Fixture',
  line1: '1 Test Street',
  line2: '',
  city: 'New York',
  state: 'NY',
  postalCode: '10001',
  country: 'US',
  phone: '',
};
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 1, priceCents: 1000 });
  admission = fakeAdmissionNamespace();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await dispose();
});

type CartRef = { cartId: string; cartRevision: number };
async function pending(discountCode?: string, cart?: CartRef) {
  const id = crypto.randomUUID();
  const input = {
    email: `${id}@example.invalid`,
    lines: [{ sku: 'TEE-1', qty: 1 }],
    shippingRateId: 'test-rate',
    shippingCountry: 'US',
    discountCode,
  };
  const quote = await quoteOrder(db, input);
  const order = await createPendingOrder(db, input, {
    id,
    ownerType: 'guest',
    userId: null,
    guestCapabilityHash: 'fixture',
    fingerprint: id,
    shippingAddress: address,
    sessionExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    payloadFor: async () => ({}),
    ...cart,
  });
  return { id, quote, order };
}
async function attempt(discountCode?: string, cart?: CartRef) {
  const { id, quote, order } = await pending(discountCode, cart);
  const frozen = {
    subtotalCents: quote.subtotalCents,
    discountCents: quote.discountCents,
    shippingCents: quote.shippingCents,
    taxCents: 0,
    totalCents: quote.totalCents,
    currency: quote.currency,
  };
  await db
    .prepare('UPDATE orders SET stripe_checkout_session_id=? WHERE id=?')
    .bind(`cs_${id}`, order.orderId)
    .run();
  await db
    .prepare(
      `UPDATE checkout_intents SET state='ready',stripe_session_id=?,checkout_url=?,
    quote_json=?,quote_confirmed_at=?,payment_intent_id=? WHERE id=?`
    )
    .bind(
      `cs_${id}`,
      'https://stripe.test',
      JSON.stringify(frozen),
      new Date().toISOString(),
      quote.totalCents ? `pi_${id}` : null,
      id
    )
    .run();
  const pi: PaymentIntentDetails = {
    id: `pi_${id}`,
    status: 'requires_capture',
    amount: quote.totalCents,
    amountCapturable: quote.totalCents,
    amountReceived: 0,
    currency: quote.currency,
    metadata: { order_id: order.orderId, attempt_id: id },
  };
  const capture = vi.fn(async (_id: string, amount: number) => {
    expect(amount).toBe(quote.totalCents);
    pi.status = 'succeeded';
    pi.amountReceived = amount;
    pi.amountCapturable = 0;
    return { ...pi };
  });
  const cancel = vi.fn(async () => {
    pi.status = 'canceled';
    return { ...pi };
  });
  const expire = vi.fn(async () => {});
  const refund = vi.fn(async () => ({ id: `re_${id}`, status: 'succeeded' }));
  const provider = fakeProvider({
    refund,
    retrieveCheckoutSession: async () => ({
      id: `cs_${id}`,
      status: quote.totalCents ? 'complete' : 'complete',
      payment_status: quote.totalCents ? 'unpaid' : 'no_payment_required',
      payment_intent: quote.totalCents ? pi.id : null,
      amount_total: quote.totalCents,
      currency: quote.currency,
      metadata: pi.metadata,
    }),
    retrievePaymentIntent: async () => ({ ...pi }),
    capturePaymentIntent: capture,
    cancelPaymentIntent: cancel,
    expireCheckoutSession: expire,
  });
  return { id, orderId: order.orderId, pi, capture, cancel, expire, refund, provider };
}
async function stock() {
  return db.prepare('SELECT on_hand,reserved FROM stock').first();
}
async function run(a: Awaited<ReturnType<typeof attempt>>) {
  await runAuthorizedCheckout(db, a.provider, a.id, admission.namespace);
}

it('preparation holds nothing; competing authorizations allocate the last unit once', async () => {
  const a = await attempt(),
    b = await attempt();
  expect(await stock()).toMatchObject({ on_hand: 1, reserved: 0 });
  expect((await db.prepare('SELECT COUNT(*) n FROM reservations').first())?.n).toBe(0);
  await Promise.all([run(a), run(b)]);
  expect(a.capture.mock.calls.length + b.capture.mock.calls.length).toBe(1);
  expect(a.cancel.mock.calls.length + b.cancel.mock.calls.length).toBe(1);
  expect(await stock()).toMatchObject({ on_hand: 0, reserved: 0 });
  await run(a);
  await run(b);
  expect(a.capture.mock.calls.length + b.capture.mock.calls.length).toBe(1);
  expect(
    (await db.prepare("SELECT COUNT(*) n FROM orders WHERE payment_status='paid'").first())?.n
  ).toBe(1);
  await expectLedgerMatchesCounters(db, 'TEE-1');
});

it('an uncertain capture retains allocation and finalizes through retrieval without recapture', async () => {
  const a = await attempt();
  a.capture.mockImplementationOnce(async () => {
    a.pi.status = 'succeeded';
    a.pi.amountReceived = a.pi.amount;
    a.pi.amountCapturable = 0;
    throw new Error('lost capture response');
  });
  await run(a);
  expect(await stock()).toMatchObject({ on_hand: 1, reserved: 1 });
  expect((await loadIntent(db, a.id))?.payment_state).toBe('capture_uncertain');
  await run(a);
  expect((await loadIntent(db, a.id))?.payment_state).toBe('finalized');
  expect(a.capture).toHaveBeenCalledTimes(1);
  expect(await stock()).toMatchObject({ on_hand: 0, reserved: 0 });
  expect(
    (await db.prepare("SELECT COUNT(*) n FROM outbox WHERE id LIKE 'receipt-%'").first())?.n
  ).toBe(1);
});

it('a fully refunded capture before finalization compensates without another refund or receipt', async () => {
  const a = await attempt();
  a.capture.mockImplementationOnce(async () => {
    a.pi.status = 'succeeded';
    a.pi.amountReceived = a.pi.amount;
    throw new Error('lost capture response');
  });
  await run(a);
  await db
    .prepare(
      `INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,status,created_at)
    VALUES('external','external',?,1000,'external','succeeded',?)`
    )
    .bind(a.orderId, new Date().toISOString())
    .run();
  await run(a);
  await run(a);
  expect(await stock()).toMatchObject({ on_hand: 1, reserved: 0 });
  expect(
    await db.prepare('SELECT status,payment_status FROM orders WHERE id=?').bind(a.orderId).first()
  ).toMatchObject({ status: 'canceled', payment_status: 'refunded' });
  expect(a.refund).not.toHaveBeenCalled();
  expect(
    (await db.prepare("SELECT COUNT(*) n FROM outbox WHERE id LIKE 'receipt-%'").first())?.n
  ).toBe(0);
});

it('canceling an authorized attempt cancels the PaymentIntent without capture', async () => {
  const a = await attempt();
  await db.prepare('UPDATE checkout_intents SET cancel_requested=1 WHERE id=?').bind(a.id).run();
  await run(a);
  expect(a.cancel).toHaveBeenCalledTimes(1);
  expect(a.expire).not.toHaveBeenCalled();
  expect(a.capture).not.toHaveBeenCalled();
  expect(await stock()).toMatchObject({ on_hand: 1, reserved: 0 });
  expect(await cancelEmails(a.id)).toBe(1);
});

it('zero-total completion allocates once without a monetary capture or refund', async () => {
  await db
    .prepare(
      `INSERT INTO discounts(id,code,type,value,status,usage_per_customer,created_at)
    VALUES('free','FREE','percentage',100,'active',1,?)`
    )
    .bind(new Date().toISOString())
    .run();
  const a = await attempt('FREE');
  expect(await stock()).toMatchObject({ on_hand: 1, reserved: 0 });
  expect((await db.prepare('SELECT usage_count FROM discounts').first())?.usage_count).toBe(0);
  await run(a);
  await run(a);
  expect((await loadIntent(db, a.id))?.payment_state).toBe('finalized');
  expect(await stock()).toMatchObject({ on_hand: 0, reserved: 0 });
  expect((await db.prepare('SELECT usage_count FROM discounts').first())?.usage_count).toBe(1);
  expect(a.capture).not.toHaveBeenCalled();
  expect(a.refund).not.toHaveBeenCalled();
});

async function shopperCart() {
  const { creds } = await ensureCart(db, null);
  await addCartLine(db, creds, 'TEE-1', 1);
  const revision = (await cartIdentity(db, creds))?.revision ?? -1;
  return { creds, ref: { cartId: creds.id, cartRevision: revision } };
}
const idleProvider: PaymentProvider = {
  createCheckout: vi.fn(),
  verifyWebhook: vi.fn(),
  refund: vi.fn(),
};
async function cancelEmails(id: string) {
  return (
    await db
      .prepare('SELECT COUNT(*) n FROM outbox WHERE id=?')
      .bind(`authorization-canceled-${id}`)
      .first()
  )?.n;
}

it('a replaced checkout that never reached Stripe ends canceled without emailing the shopper', async () => {
  const { ref } = await shopperCart();
  const first = await pending(undefined, ref);
  await pending(undefined, ref);
  await runAuthorizedCheckout(db, idleProvider, first.id, admission.namespace);
  expect(await loadIntent(db, first.id)).toMatchObject({
    payment_state: 'canceled',
    state: 'canceled',
  });
  expect(
    await db.prepare('SELECT status FROM orders WHERE id=?').bind(first.order.orderId).first()
  ).toMatchObject({ status: 'canceled' });
  expect(await cancelEmails(first.id)).toBe(0);
  await runAuthorizedCheckout(db, idleProvider, first.id, admission.namespace);
  expect((await loadIntent(db, first.id))?.payment_state).toBe('canceled');
});

it('a canceled checkout whose Stripe page may still be payable waits for that page to expire', async () => {
  const a = await pending();
  await db
    .prepare(
      "UPDATE checkout_intents SET cancel_requested=1,provider_step='session',session_expires_at=? WHERE id=?"
    )
    .bind(new Date(Date.now() + 600_000).toISOString(), a.id)
    .run();
  await runAuthorizedCheckout(db, idleProvider, a.id, admission.namespace);
  const waiting = await loadIntent(db, a.id);
  expect(waiting?.payment_state).not.toBe('canceled');
  expect(Date.parse(waiting?.payment_next_at ?? '')).toBeGreaterThan(Date.now());
  await db
    .prepare('UPDATE checkout_intents SET session_expires_at=? WHERE id=?')
    .bind(new Date(Date.now() - 1000).toISOString(), a.id)
    .run();
  await runAuthorizedCheckout(db, idleProvider, a.id, admission.namespace);
  expect((await loadIntent(db, a.id))?.payment_state).toBe('canceled');
  expect(await cancelEmails(a.id)).toBe(1);
});

it('a canceled checkout keeps waiting while its Stripe page is still being created', async () => {
  const a = await pending();
  await db
    .prepare(
      "UPDATE checkout_intents SET cancel_requested=1,state='session_creating',claim_expires_at=? WHERE id=?"
    )
    .bind(new Date(Date.now() + 60_000).toISOString(), a.id)
    .run();
  await runAuthorizedCheckout(db, idleProvider, a.id, admission.namespace);
  expect((await loadIntent(db, a.id))?.payment_state).not.toBe('canceled');
});

async function seedSecondVariant() {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO variants (id, product_id, sku, title, price_cents, status, continue_selling, created_at) VALUES ('v2', 'p1', 'TEE-2', 'Second', 1000, 'active', 0, ?)"
      )
      .bind(now),
    db
      .prepare("INSERT INTO stock (sku, on_hand, reserved, updated_at) VALUES ('TEE-2', 5, 0, ?)")
      .bind(now),
  ]);
}
async function cartState(cartId: string) {
  const cart = await db
    .prepare('SELECT status,active_checkout_id,revision FROM carts WHERE id=?')
    .bind(cartId)
    .first<{ status: string; active_checkout_id: string | null; revision: number }>();
  const lines = await db
    .prepare('SELECT sku,qty FROM cart_items WHERE cart_id=? ORDER BY sku')
    .bind(cartId)
    .all();
  return { cart, lines: lines.results };
}

it('editing the cart after the shopper approved payment still captures the approved order', async () => {
  await seedSecondVariant();
  const { creds, ref } = await shopperCart();
  const a = await attempt(undefined, ref);
  await addCartLine(db, creds, 'TEE-1', 1);
  await addCartLine(db, creds, 'TEE-2', 2);
  const editedRevision = (await cartIdentity(db, creds))?.revision ?? -1;
  await run(a);
  expect(a.capture).toHaveBeenCalledTimes(1);
  expect(a.cancel).not.toHaveBeenCalled();
  expect((await loadIntent(db, a.id))?.payment_state).toBe('finalized');
  const settled = await cartState(ref.cartId);
  expect(settled.cart).toMatchObject({ status: 'open', active_checkout_id: null });
  expect(settled.cart?.revision).toBeGreaterThan(editedRevision);
  expect(settled.lines).toEqual([
    { sku: 'TEE-1', qty: 1 },
    { sku: 'TEE-2', qty: 2 },
  ]);
  await run(a);
  expect(await cartState(ref.cartId)).toEqual(settled);
});

it('an edited cart drops a purchased line that only held the purchased quantity', async () => {
  await seedSecondVariant();
  const { creds, ref } = await shopperCart();
  const a = await attempt(undefined, ref);
  await addCartLine(db, creds, 'TEE-2', 1);
  await run(a);
  expect(await cartState(ref.cartId)).toMatchObject({
    cart: { status: 'open', active_checkout_id: null },
    lines: [{ sku: 'TEE-2', qty: 1 }],
  });
});

it('an unedited cart converts when its approved order settles', async () => {
  const { ref } = await shopperCart();
  const a = await attempt(undefined, ref);
  await run(a);
  expect((await loadIntent(db, a.id))?.payment_state).toBe('finalized');
  expect((await cartState(ref.cartId)).cart).toMatchObject({ status: 'converted' });
});

it('a replaced checkout whose Stripe page expired ends canceled without emailing the shopper', async () => {
  const { ref } = await shopperCart();
  const a = await attempt(undefined, ref);
  await pending(undefined, ref);
  await db
    .prepare('UPDATE checkout_intents SET payment_intent_id=NULL WHERE id=?')
    .bind(a.id)
    .run();
  a.provider.retrieveCheckoutSession = async () => ({
    id: `cs_${a.id}`,
    status: 'expired',
    payment_status: 'unpaid',
    payment_intent: null,
    amount_total: a.pi.amount,
    currency: a.pi.currency,
    metadata: a.pi.metadata,
  });
  await run(a);
  expect((await loadIntent(db, a.id))?.payment_state).toBe('canceled');
  expect(await cancelEmails(a.id)).toBe(0);
});

it('a replaced checkout whose PaymentIntent was canceled ends canceled without emailing the shopper', async () => {
  const { ref } = await shopperCart();
  const a = await attempt(undefined, ref);
  await pending(undefined, ref);
  a.pi.status = 'canceled';
  await run(a);
  expect((await loadIntent(db, a.id))?.payment_state).toBe('canceled');
  expect(await cancelEmails(a.id)).toBe(0);
});

it('a capture for a paid shopper goes through while new checkouts hold every start permit', async () => {
  const a = await attempt();
  const start = admission.namespace.getByName('store');
  for (let i = 0; i < 10; i++) expect((await start.acquire()).ok).toBe(true);
  expect((await start.acquire()).ok).toBe(false);
  await run(a);
  expect(a.capture).toHaveBeenCalledTimes(1);
  expect((await loadIntent(db, a.id))?.payment_state).toBe('finalized');
});

it('a busy settle lane retries after the controller hint plus a little jitter', async () => {
  const tight = fakeAdmissionNamespace({
    admission_starts_per_second: 1,
    admission_burst: 1,
    admission_max_active: 10,
  });
  expect((await tight.namespace.getByName('settle').acquire()).ok).toBe(true);
  const a = await attempt();
  const before = Date.now();
  await runAuthorizedCheckout(db, a.provider, a.id, tight.namespace);
  expect(a.capture).not.toHaveBeenCalled();
  const wait = Date.parse((await loadIntent(db, a.id))?.payment_next_at ?? '') - before;
  expect(wait).toBeGreaterThanOrEqual(1000);
  expect(wait).toBeLessThan(6000);
});

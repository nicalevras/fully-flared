import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct, expectLedgerMatchesCounters } from './helpers/d1';
import { fakeAdmissionNamespace } from './helpers/admission';
import { createPendingOrder, quoteOrder } from '../web/src/server/checkout';
import { loadIntent } from '../web/src/server/checkout-intents';
import { runAuthorizedCheckout } from '../web/src/server/authorized-checkout';
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

async function attempt(discountCode?: string) {
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
    manualCapture: true,
    shippingAddress: address,
    holdExpiresAt: null,
    sessionExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    payloadFor: async () => ({}),
  });
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
  const provider = {
    createCheckout: vi.fn(),
    verifyWebhook: vi.fn(),
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
  } as unknown as PaymentProvider;
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

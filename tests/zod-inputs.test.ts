import { describe, expect, it } from 'vitest';
import {
  checkoutBodySchema,
  discountValidateBodySchema,
  pricingBodySchema,
  returnCreateBodySchema,
} from '../web/src/schemas/checkout';
import { adminActionSchema } from '../web/src/schemas/admin';
import { accountActionSchema, reportQuerySchema } from '../web/src/schemas/account';
import { jobMessageSchema, emailMessageSchema } from '../web/src/schemas/queue';
import { stripeEventSchema, checkoutMetadataSchema } from '../web/src/schemas/webhook';
import { parseJsonBody, validationError } from '../web/src/schemas/common';
import { successSearchSchema, searchQueryParamSchema } from '../web/src/schemas/checkout';

describe('checkout body', () => {
  it('accepts a valid checkout', () => {
    const r = checkoutBodySchema.safeParse({
      intentId: '123e4567-e89b-42d3-a456-426614174000',
      email: 'a@b.com',
      shippingCountry: 'US',
      shippingRateId: 'test-rate',
      lines: [{ sku: 'TEE-1', qty: 2 }],
    });
    expect(r.success).toBe(true);
  });
  it('rejects bad email, zero qty, and empty lines instead of defaulting', () => {
    expect(
      checkoutBodySchema.safeParse({ email: 'nope', lines: [{ sku: 'X', qty: 1 }] }).success
    ).toBe(false);
    expect(
      checkoutBodySchema.safeParse({
        email: 'a@b.com',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [{ sku: 'X', qty: 0 }],
      }).success
    ).toBe(false);
    expect(
      checkoutBodySchema.safeParse({
        email: 'a@b.com',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [],
      }).success
    ).toBe(false);
    expect(checkoutBodySchema.safeParse({}).success).toBe(false);
  });
  it('pricing and discount and returns reject malformed input', () => {
    expect(pricingBodySchema.safeParse({ skus: 'TEE-1' }).success).toBe(false);
    expect(
      discountValidateBodySchema.safeParse({ code: 'X', subtotalCents: -5, email: 'a@b.com' })
        .success
    ).toBe(false);
    expect(returnCreateBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('admin action union', () => {
  it('accepts typed actions and rejects unknown or under-specified ones', () => {
    expect(
      adminActionSchema.safeParse({ action: 'stock.adjust', sku: 'TEE-1', delta: 5 }).success
    ).toBe(true);
    expect(
      adminActionSchema.safeParse({ action: 'stock.adjust', sku: 'TEE-1', delta: 'five' }).success
    ).toBe(false);
    expect(adminActionSchema.safeParse({ action: 'product.explode', productId: 'x' }).success).toBe(
      false
    );
    expect(
      adminActionSchema.safeParse({ action: 'user.setRole', userId: 'u1', role: 'superuser' })
        .success
    ).toBe(false);
    expect(
      adminActionSchema.safeParse({ action: 'variant.bulkUpdate', variantIds: [], priceCents: 100 })
        .success
    ).toBe(false);
  });
});

describe('account + reports + queue + webhook envelopes', () => {
  it('account actions are discriminated', () => {
    expect(
      accountActionSchema.safeParse({ action: 'address.delete', addressId: 'a1' }).success
    ).toBe(true);
    expect(accountActionSchema.safeParse({ action: 'address.delete' }).success).toBe(false);
    expect(
      accountActionSchema.safeParse({ action: 'account.delete', confirmEmail: 'bad' }).success
    ).toBe(false);
  });
  it('report query rejects unknown values and defaults missing ones', () => {
    expect(reportQuerySchema.safeParse({ type: 'nope', format: 'xml' }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ format: 'xml' }).success).toBe(false);
    const r = reportQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ type: 'sales', format: 'json' });
  });
  it('queue jobs and emails are discriminated unions', () => {
    expect(jobMessageSchema.safeParse({ type: 'webhook.process', eventId: 'evt_1' }).success).toBe(
      true
    );
    expect(jobMessageSchema.safeParse({ type: 'webhook.process' }).success).toBe(false);
    expect(jobMessageSchema.safeParse({ type: 'unknown.job' }).success).toBe(false);
    expect(
      emailMessageSchema.safeParse({ to: 'a@b.com', subject: 'Hi', text: 'x', html: '<p>x</p>' })
        .success
    ).toBe(true);
  });
  it('stripe envelope and checkout metadata parse', () => {
    expect(
      stripeEventSchema.safeParse({
        id: 'evt_1',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_1' } },
      }).success
    ).toBe(true);
    expect(stripeEventSchema.safeParse({ id: 'evt_1', type: 'x', data: {} }).success).toBe(false);
    expect(checkoutMetadataSchema.safeParse({ order_id: 'o1', attempt_id: 'a1' }).success).toBe(
      true
    );
    expect(checkoutMetadataSchema.safeParse({ attempt_id: 'a1' }).success).toBe(false);
  });
});

describe('HTTP boundary parsing', () => {
  it('malformed JSON is a typed 400, never an empty-object default', async () => {
    const req = new Request('http://x/api/checkout', { method: 'POST', body: '{not json' });
    const r = await parseJsonBody(req, checkoutBodySchema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(400);
      const body = (await r.response.json()) as { fieldErrors: unknown[] };
      expect(body.fieldErrors.length).toBeGreaterThan(0);
    }
  });
  it('schema failure returns field errors', async () => {
    const req = new Request('http://x/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'bad', lines: [] }),
    });
    const r = await parseJsonBody(req, checkoutBodySchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });
  it('valid body parses once and returns typed data', async () => {
    const req = new Request('http://x/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intentId: '123e4567-e89b-42d3-a456-426614174000',
        email: 'a@b.com',
        shippingCountry: 'US',
        shippingRateId: 'test-rate',
        lines: [{ sku: 'TEE-1', qty: 1 }],
      }),
    });
    const r = await parseJsonBody(req, checkoutBodySchema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.lines[0]?.sku).toBe('TEE-1');
  });
  it('search-param schemas apply defaults without hand-written casts', () => {
    expect(searchQueryParamSchema.parse({})).toEqual({ q: '' });
    expect(successSearchSchema.parse({})).toEqual({ order: '', t: '' });
    expect(successSearchSchema.parse({ order: 'ord_1', t: 'abc' })).toEqual({
      order: 'ord_1',
      t: 'abc',
    });
    const bad = checkoutBodySchema.safeParse({});
    expect(bad.success).toBe(false);
    if (!bad.success) expect(validationError(bad.error).fieldErrors.length).toBeGreaterThan(0);
  });
});

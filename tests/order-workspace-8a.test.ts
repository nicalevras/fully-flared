import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync('web/src/routes/admin/orders/$id.tsx', 'utf8');

describe('Phase 8A order workspace contract', () => {
  it('shows one next action and a packing slip without payment data', () => {
    expect(source).toContain('Next action:');
    expect(source).toContain('id="packing-slip"');
    const slip = source.slice(source.indexOf('id="packing-slip"'));
    expect(slip).toContain('no prices, payment details');
    expect(slip).not.toContain('stripe_payment_intent_id');
    expect(slip).not.toContain('customer_email');
  });

  it('builds the timeline without inventing a payment timestamp', () => {
    expect(source).not.toContain("'Payment confirmed'");
    expect(source).toContain('Payment ${order.payment_status');
  });
});

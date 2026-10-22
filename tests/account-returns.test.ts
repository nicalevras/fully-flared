import { expect, it } from 'vitest';
import {
  canRequestReturn,
  customerReturnLabel,
  groupReturnsByOrder,
} from '../web/src/lib/account-returns';

const ret = (id: string, order_id: string, status: string, created_at: string) => ({
  id,
  order_id,
  status,
  created_at,
});

it('shows the latest return first when an order has two returns', () => {
  // Loader order is newest-first.
  const grouped = groupReturnsByOrder([
    ret('new', 'o1', 'requested', '2026-02-01'),
    ret('old', 'o1', 'refunded', '2026-01-01'),
    ret('other', 'o2', 'approved', '2026-01-15'),
  ]);
  expect(grouped.get('o1')?.map((r) => r.id)).toEqual(['new', 'old']);
  expect(grouped.get('o1')?.[0]?.status).toBe('requested');
  expect(grouped.get('o2')?.map((r) => r.id)).toEqual(['other']);
});

it('a partially refunded order with remaining units can request another return', () => {
  expect(
    canRequestReturn({
      paymentStatus: 'partially_refunded',
      returns: [ret('r1', 'o1', 'refunded', '2026-01-01')],
      items: [
        { qty: 2, returned_qty: 2 },
        { qty: 1, returned_qty: 0 },
      ],
    })
  ).toBe(true);
});

it('a fully returned order cannot request another return', () => {
  expect(
    canRequestReturn({
      paymentStatus: 'partially_refunded',
      returns: [ret('r1', 'o1', 'refunded', '2026-01-01')],
      items: [{ qty: 2, returned_qty: 2 }],
    })
  ).toBe(false);
});

it('an open return or unpaid order blocks a new return; refund_failed does not', () => {
  const items = [{ qty: 1, returned_qty: 0 }];
  expect(
    canRequestReturn({
      paymentStatus: 'paid',
      returns: [ret('r1', 'o1', 'requested', '2026-01-01')],
      items,
    })
  ).toBe(false);
  expect(
    canRequestReturn({
      paymentStatus: 'paid',
      returns: [ret('r1', 'o1', 'approved', '2026-01-01')],
      items,
    })
  ).toBe(false);
  expect(
    canRequestReturn({
      paymentStatus: 'paid',
      returns: [ret('r1', 'o1', 'refund_failed', '2026-01-01')],
      items,
    })
  ).toBe(true);
  expect(canRequestReturn({ paymentStatus: 'unpaid', returns: [], items })).toBe(false);
});

it('customers never see the raw refund_failed status', () => {
  expect(customerReturnLabel('refund_failed')).toBe('Refund processing');
  expect(customerReturnLabel('refunded')).toBe('refunded');
});

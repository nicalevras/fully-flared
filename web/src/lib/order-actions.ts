import { formatMoney } from './format';

export const SHIPPABLE_ORDER_STATUSES = ['paid', 'processing', 'partially_refunded'] as const;
export const SHIPPABLE_PAYMENT_STATUSES = ['paid', 'partially_refunded'] as const;
export function canShipOrder(order: {
  status: string;
  payment_status: string;
  restocked_at?: string | null;
}) {
  // A restocked order was fully refunded once and its units returned to
  // saleable stock. A later refund reversal must not reopen fulfillment:
  // shipping it again requires an explicit inventory recovery.
  if (order.restocked_at) return false;
  return (
    SHIPPABLE_ORDER_STATUSES.some((s) => s === order.status) &&
    SHIPPABLE_PAYMENT_STATUSES.some((s) => s === order.payment_status)
  );
}
export function availableRefundCents(
  total: number,
  refunds: Array<{ amount_cents: number; status: string }>
) {
  return Math.max(
    0,
    total -
      refunds.reduce(
        (sum, r) => sum + (['failed', 'canceled'].includes(r.status) ? 0 : r.amount_cents),
        0
      )
  );
}
export type ReturnCalcLine = { orderItemId: string; qty: number; unitPriceCents: number };

// What the customer actually paid per order line: gross minus the line's
// pro-rata share of the order discount plus its pro-rata share of tax,
// allocated in integer cents rounding down. Shipping is never allocated.
export function allocatedLinePaidCents(
  lines: ReturnCalcLine[],
  discountCents: number,
  taxCents: number
): number[] {
  const subtotal = lines.reduce((sum, l) => sum + l.qty * l.unitPriceCents, 0);
  if (subtotal <= 0) return lines.map(() => 0);
  return lines.map((l) => {
    const gross = l.qty * l.unitPriceCents;
    const discountShare = Math.floor((discountCents * gross) / subtotal);
    const taxShare = Math.floor((taxCents * gross) / subtotal);
    return gross - discountShare + taxShare;
  });
}

// Default refund for a return's items (option C, shipping excluded): each
// item contributes its pro-rata paid share rounding down; a return that
// completes the order takes the remaining balance up to total minus
// shipping so rounding is absorbed but shipping is never refunded.
export function calculatedReturnRefundCents(input: {
  lines: ReturnCalcLine[];
  items: Array<{ orderItemId: string; qty: number }>;
  returnedBeforeQty: Record<string, number>;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  shippingCents: number;
  refundableCents: number;
}): number {
  const { lines, items, returnedBeforeQty } = input;
  if (items.length === 0) return Math.max(0, input.refundableCents - input.shippingCents);
  const paid = allocatedLinePaidCents(lines, input.discountCents, input.taxCents);
  const paidById = new Map(lines.map((l, i) => [l.orderItemId, paid[i] ?? 0]));
  const thisQty = new Map(items.map((i) => [i.orderItemId, i.qty]));
  const isFinal = lines.every(
    (l) => (returnedBeforeQty[l.orderItemId] ?? 0) + (thisQty.get(l.orderItemId) ?? 0) >= l.qty
  );
  if (isFinal) {
    const alreadyRefunded = input.totalCents - input.refundableCents;
    const target = Math.max(0, input.totalCents - input.shippingCents) - alreadyRefunded;
    return Math.max(0, Math.min(input.refundableCents, target));
  }
  const sum = items.reduce((total, item) => {
    const line = lines.find((l) => l.orderItemId === item.orderItemId);
    if (!line || line.qty <= 0) return total;
    return total + Math.floor(((paidById.get(item.orderItemId) ?? 0) * item.qty) / line.qty);
  }, 0);
  return Math.max(0, Math.min(input.refundableCents, sum));
}

/** Per-item quantities from returns that have actually been refunded.
 * Only these count toward a return being the "final" one: a return that is
 * merely requested, approved, or refund-failed has not completed the money
 * side, so it must not make another return absorb the remaining balance. */
export function refundedQtyBefore(
  returns: Array<{
    id: string;
    status: string;
    items: Array<{ order_item_id: string; qty: number }>;
  }>,
  excludeReturnId: string
): Record<string, number> {
  const qty: Record<string, number> = {};
  for (const ret of returns) {
    if (ret.id === excludeReturnId || ret.status !== 'refunded') continue;
    for (const item of ret.items)
      qty[item.order_item_id] = (qty[item.order_item_id] ?? 0) + item.qty;
  }
  return qty;
}

export function refundOutcomeMessage(status: string, amount: number, currency: string) {
  const money = `${currency} ${formatMoney(amount, currency)}`;
  return status === 'succeeded'
    ? `Refund completed: ${money}.`
    : ['failed', 'canceled'].includes(status)
      ? `Refund ${status}: ${money}. No refund completed; check the operation before retrying.`
      : `Refund ${status === 'uncertain' ? 'awaiting confirmation' : status.replace(/_/g, ' ')}: ${money}. Settlement has not completed.`;
}
export function refundStatusLabel(status: string) {
  if (status === 'succeeded') return 'Settled';
  if (status === 'failed') return 'Failed';
  if (status === 'canceled') return 'Canceled';
  if (status === 'uncertain') return 'Submitted, awaiting confirmation';
  return 'Submitted, not settled yet';
}
export function refundActionMessage(data: unknown, currency: string) {
  return typeof data === 'object' &&
    data !== null &&
    'refundStatus' in data &&
    'amountCents' in data &&
    typeof data.refundStatus === 'string' &&
    typeof data.amountCents === 'number' &&
    Number.isFinite(data.amountCents)
    ? refundOutcomeMessage(data.refundStatus, data.amountCents, currency)
    : 'Refund result unavailable. Refresh the order before retrying.';
}

/** Account-page return display and eligibility. The server
 * (lib/shopFns.ts createReturnFn) is the authority; this mirrors its rules
 * so the page only offers a return the server would accept: payment status
 * paid or partially_refunded, no open return (requested/approved — a
 * refund_failed return does not block), and returnable quantity left under
 * the per-item caps (bought minus already returned, rejected excluded). */

export type AccountReturnLike = {
  id: string;
  order_id: string;
  status: string;
  created_at: string;
};

/** Group returns by order, preserving the loader's newest-first order
 * inside each group so the latest return is shown first. */
export function groupReturnsByOrder<T extends AccountReturnLike>(returns: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const ret of returns) {
    const list = grouped.get(ret.order_id) ?? [];
    list.push(ret);
    grouped.set(ret.order_id, list);
  }
  return grouped;
}

export function canRequestReturn(input: {
  paymentStatus: string;
  returns: Array<{ status: string }>;
  items: Array<{ qty: number; returned_qty: number }>;
}): boolean {
  if (input.paymentStatus !== 'paid' && input.paymentStatus !== 'partially_refunded') return false;
  if (input.returns.some((r) => r.status === 'requested' || r.status === 'approved')) return false;
  return input.items.some((i) => i.qty - i.returned_qty > 0);
}

/** Customer-facing label: internal failure states are never shown raw. */
export function customerReturnLabel(status: string): string {
  return status === 'refund_failed' ? 'Refund processing' : status;
}

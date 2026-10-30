import { useState } from 'react';
import { staffMiddleware } from '../../../server/staff-middleware';
import { requireStaffPermission } from '../../../server/session';
import { LocalDate } from '../../../components/LocalDate';
import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { validateServerInput } from '../../../server/function-boundary';
import { idString } from '../../../schemas/common';
import { useAdminAction, type AdminPayload } from '../../../components/AdminNav';
import { formatMoney } from '../../../components/ProductCard';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../../components/AdminActionFeedback';
import { ConfirmDialog, type ConfirmRequest } from '../../../components/ConfirmDialog';
import { StatusBadge } from '../../../components/StatusBadge';
import type { OrderStatus, PaymentStatus, RefundStatus, ReturnStatus } from '../../../db/schema';
import {
  canShipOrder,
  availableRefundCents,
  calculatedReturnRefundCents,
  refundActionMessage,
  refundStatusLabel,
  refundedQtyBefore,
} from '../../../lib/order-actions';
import { roles, type StaffRole } from '../../../lib/permissions';
import {
  btnPrimary,
  btnSecondary,
  btnSmall,
  cardCls,
  inputCls,
  labelCls,
  pageSub,
  pageTitle,
} from '../../../components/ui';

type OrderDetail = {
  id: string;
  number: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  customer_email: string;
  currency: string;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  shipping_name: string | null;
  shipping_address_json: string | null;
  tracking_number: string | null;
  shipped_at: string | null;
  restocked_at: string | null;
  stripe_payment_intent_id: string | null;
  created_at: string;
  updated_at: string;
  items: Array<{
    id: string;
    sku: string;
    title: string;
    qty: number;
    unit_price_cents: number;
  }>;
  refunds: Array<{
    id: string;
    return_id: string | null;
    amount_cents: number;
    status: RefundStatus;
    created_at: string;
  }>;
  permissions: { ship: boolean; refund: boolean; approve: boolean; reject: boolean };
  returns: Array<{
    id: string;
    reason: string;
    status: ReturnStatus;
    created_at: string;
    items: Array<{
      order_item_id: string;
      sku: string;
      title: string;
      qty: number;
      unit_price_cents: number;
    }>;
  }>;
} | null;

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(idString))
  .handler(async ({ data: orderId, context }): Promise<OrderDetail> => {
    requireStaffPermission(context.staff, 'order', 'view');
    const { env } = await import('cloudflare:workers');
    const db = env.DB;
    const order = await db
      .prepare(
        `SELECT id, number, status, payment_status, customer_email, currency,
              subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents,
              shipping_name, shipping_address_json, tracking_number, shipped_at, restocked_at,
              stripe_payment_intent_id, created_at, updated_at
       FROM orders WHERE id = ?`
      )
      .bind(orderId)
      .first<Omit<NonNullable<OrderDetail>, 'items' | 'refunds' | 'returns' | 'permissions'>>();
    if (!order) return null;
    const [items, refunds, returnsRaw] = await Promise.all([
      db
        .prepare('SELECT id, sku, title, qty, unit_price_cents FROM order_items WHERE order_id = ?')
        .bind(orderId)
        .all<NonNullable<OrderDetail>['items'][number]>(),
      db
        .prepare(
          'SELECT id,return_id,amount_cents, status, created_at FROM refunds WHERE order_id = ? ORDER BY created_at DESC,id DESC'
        )
        .bind(orderId)
        .all<NonNullable<OrderDetail>['refunds'][number]>(),
      db
        .prepare(
          'SELECT id, reason, status, created_at FROM returns WHERE order_id = ? ORDER BY created_at DESC'
        )
        .bind(orderId)
        .all<Omit<NonNullable<OrderDetail>['returns'][number], 'items'>>(),
    ]);
    const returnItemRows =
      returnsRaw.results.length > 0
        ? await db
            .prepare(
              `SELECT ri.return_id, ri.order_item_id, ri.sku, ri.title, ri.qty, ri.unit_price_cents
               FROM return_items ri JOIN returns r ON r.id = ri.return_id WHERE r.order_id = ?`
            )
            .bind(orderId)
            .all<
              NonNullable<OrderDetail>['returns'][number]['items'][number] & { return_id: string }
            >()
        : { results: [] as Array<never> };
    const itemsByReturn = new Map<string, NonNullable<OrderDetail>['returns'][number]['items']>();
    for (const row of returnItemRows.results) {
      const { return_id, ...item } = row;
      itemsByReturn.set(return_id, [...(itemsByReturn.get(return_id) ?? []), item]);
    }
    const role = roles[context.staff.role as StaffRole];
    return {
      ...order,
      items: items.results,
      refunds: refunds.results,
      returns: returnsRaw.results.map((r) => ({ ...r, items: itemsByReturn.get(r.id) ?? [] })),
      permissions: {
        ship: role?.authorize({ order: ['ship'] }).success ?? false,
        refund: role?.authorize({ order: ['refund'] }).success ?? false,
        approve: role?.authorize({ return: ['approve'] }).success ?? false,
        reject: role?.authorize({ return: ['reject'] }).success ?? false,
      },
    };
  });

export const Route = createFileRoute('/admin/orders/$id')({
  loader: async ({ params }) => getData({ data: params.id }),
  component: OrderPage,
});

function formatAddress(json: string | null): string[] {
  if (!json) return [];
  try {
    const a = JSON.parse(json) as Record<string, string | undefined>;
    return [
      a.line1,
      a.line2,
      [a.city, a.state, a.postal_code].filter(Boolean).join(', '),
      a.country,
    ].filter(Boolean) as string[];
  } catch {
    return [json];
  }
}

function OrderPage() {
  const adminAction = useAdminAction();

  const order = Route.useLoaderData();
  const router = useRouter();
  const [tracking, setTracking] = useState('');
  const [refundAmount, setRefundAmount] = useState('');
  const [returnAmounts, setReturnAmounts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<AdminActionFeedbackState>(null);
  const [busy, setBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{
    request: ConfirmRequest;
    run: () => void;
  } | null>(null);

  if (!order) {
    return (
      <main>
        <h1 className={pageTitle}>Order not found</h1>
        <p className={pageSub}>This order does not exist.</p>
        <Link
          to="/admin/orders"
          search={{ q: '', mode: 'number', view: 'queue', payment: 'all', from: '', to: '' }}
          className={`${btnSecondary} mt-5`}
        >
          Back to orders
        </Link>
      </main>
    );
  }

  const timeline: Array<[string, string | null, boolean]> = [
    ['Order placed', order.created_at, true],
    [
      `Payment ${order.payment_status.replace(/_/g, ' ')}`,
      null,
      order.payment_status !== 'unpaid' && order.payment_status !== 'failed',
    ],
    ['Shipped', order.shipped_at, order.status === 'shipped' || order.status === 'delivered'],
    [
      'Delivered',
      order.status === 'delivered' ? order.updated_at : null,
      order.status === 'delivered',
    ],
  ];
  const addressLines = formatAddress(order.shipping_address_json);
  const canShip = canShipOrder(order) && order.permissions.ship;
  const currency = order.currency;
  const refundable = availableRefundCents(order.total_cents, order.refunds);
  const hasOpenReturn = order.returns.some((r) =>
    ['requested', 'approved', 'refund_failed'].includes(r.status)
  );
  const returnedQtyByItem = new Map<string, number>();
  const refundedQtyByItem = new Map<string, number>();
  for (const ret of order.returns) {
    if (ret.status === 'rejected') continue;
    for (const item of ret.items) {
      returnedQtyByItem.set(
        item.order_item_id,
        (returnedQtyByItem.get(item.order_item_id) ?? 0) + item.qty
      );
      if (ret.status === 'refunded')
        refundedQtyByItem.set(
          item.order_item_id,
          (refundedQtyByItem.get(item.order_item_id) ?? 0) + item.qty
        );
    }
  }
  const refundedAmountFor = (returnId: string) =>
    order.refunds
      .filter((f) => f.return_id === returnId && f.status === 'succeeded')
      .reduce((sum, f) => sum + f.amount_cents, 0);
  const calculatedFor = (ret: NonNullable<OrderDetail>['returns'][number]) => {
    const returnedBeforeQty = refundedQtyBefore(order.returns, ret.id);
    return calculatedReturnRefundCents({
      lines: order.items.map((i) => ({
        orderItemId: i.id,
        qty: i.qty,
        unitPriceCents: i.unit_price_cents,
      })),
      items: ret.items.map((i) => ({ orderItemId: i.order_item_id, qty: i.qty })),
      returnedBeforeQty,
      discountCents: order.discount_cents,
      taxCents: order.tax_cents,
      totalCents: order.total_cents,
      shippingCents: order.shipping_cents,
      refundableCents: refundable,
    });
  };
  const canRefund =
    order.permissions.refund &&
    refundable > 0 &&
    (order.payment_status === 'paid' || order.payment_status === 'partially_refunded');

  async function run(action: string, payload: AdminPayload, ok: string) {
    setBusy(true);
    const r = await adminAction(action, payload);
    setBusy(false);
    if (r.ok) {
      setMsg({
        kind: 'status',
        message:
          action === 'order.refund' || action === 'return.refund'
            ? refundActionMessage(r.data, currency)
            : ok,
      });
      router.invalidate();
    } else setMsg({ kind: 'error', message: r.error ?? 'Failed' });
  }

  return (
    <main>
      <Link
        to="/admin/orders"
        search={{ q: '', mode: 'number', view: 'queue', payment: 'all', from: '', to: '' }}
        className="text-[13px] font-medium text-zinc-500 hover:text-zinc-950"
      >
        ← Orders
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className={pageTitle}>{order.number}</h1>
        <StatusBadge value={order.status} />
        <StatusBadge value={order.payment_status} />
      </div>
      <p className={pageSub}>
        Placed <LocalDate value={order.created_at} withTime /> · {order.customer_email}
      </p>
      <AdminActionFeedback value={msg} />
      <section
        className={`${cardCls} mt-5 flex flex-wrap items-center gap-3 p-4`}
        aria-label="Next action"
      >
        <p className="text-sm text-zinc-600">
          <span className="font-medium text-zinc-950">Next action: </span>
          {canShip
            ? 'Ship this order. Add the tracking number in Fulfillment below.'
            : hasOpenReturn
              ? 'Review the open return below before refunding anything else.'
              : canRefund
                ? 'A refund balance remains. Review Payment before refunding.'
                : 'Nothing needs attention on this order right now.'}
        </p>
        {canShip ? (
          <a href="#fulfillment" className={btnPrimary}>
            Go to fulfillment
          </a>
        ) : hasOpenReturn ? (
          <a href="#returns" className={btnPrimary}>
            Review the return
          </a>
        ) : canRefund ? (
          <a href="#payment" className={btnPrimary}>
            Review payment
          </a>
        ) : null}
        <a href="#packing-slip" className={btnSecondary}>
          Packing slip
        </a>
      </section>

      <div className="mt-6 grid items-start gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          {/* Items */}
          <section className={`${cardCls} overflow-hidden`}>
            <h2 className="px-5 pt-4 pb-3 text-sm font-medium text-zinc-950">Items</h2>
            <ul className="divide-y divide-zinc-100">
              {order.items.map((i) => (
                <li key={i.id} className="flex items-center gap-4 px-5 py-3.5">
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-[13px] font-medium text-zinc-500"
                    aria-hidden
                  >
                    {i.title.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-zinc-950">
                      {i.title}
                    </span>
                    <span className="block text-[13px] text-zinc-500">
                      {i.sku} · {i.qty} × {formatMoney(i.unit_price_cents, order.currency)}
                      {(returnedQtyByItem.get(i.id) ?? 0) > 0
                        ? ` · returned ${returnedQtyByItem.get(i.id)} · refunded ${refundedQtyByItem.get(i.id) ?? 0}`
                        : ''}
                    </span>
                  </span>
                  <span className="text-sm font-medium">
                    {formatMoney(i.unit_price_cents * i.qty, order.currency)}
                  </span>
                </li>
              ))}
            </ul>
            <dl className="space-y-2 border-t border-zinc-100 px-5 py-4 text-sm">
              <div className="flex justify-between">
                <dt className="text-zinc-500">Subtotal</dt>
                <dd>{formatMoney(order.subtotal_cents, order.currency)}</dd>
              </div>
              {order.discount_cents > 0 ? (
                <div className="flex justify-between text-green-700">
                  <dt>Discount</dt>
                  <dd>−{formatMoney(order.discount_cents, order.currency)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between">
                <dt className="text-zinc-500">Shipping</dt>
                <dd>
                  {order.shipping_cents === 0
                    ? 'Free'
                    : formatMoney(order.shipping_cents, order.currency)}
                </dd>
              </div>
              {order.tax_cents > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-zinc-500">Tax</dt>
                  <dd>{formatMoney(order.tax_cents, order.currency)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between border-t border-zinc-100 pt-2.5 font-medium text-zinc-950">
                <dt>Total</dt>
                <dd>{formatMoney(order.total_cents, order.currency)}</dd>
              </div>
            </dl>
          </section>

          {/* Fulfillment */}
          <section id="fulfillment" className={`${cardCls} p-5 sm:p-6`}>
            <h2 className="text-sm font-medium text-zinc-950">Fulfillment</h2>
            <ol className="mt-4 space-y-0" aria-label="Order timeline">
              {timeline.map(([label, at, done], i) => (
                <li key={label} className="flex gap-3">
                  <span className="flex flex-col items-center">
                    <span
                      className={`mt-0.5 h-2.5 w-2.5 rounded-full ${done ? 'bg-zinc-950' : 'bg-zinc-300'}`}
                      aria-hidden
                    />
                    {i < timeline.length - 1 ? (
                      <span className="w-px flex-1 bg-zinc-200" aria-hidden />
                    ) : null}
                  </span>
                  <span className="pb-5">
                    <span
                      className={`block text-sm ${done ? 'font-medium text-zinc-950' : 'text-zinc-400'}`}
                    >
                      {label}
                    </span>
                    {at && done ? (
                      <span className="block text-[13px] text-zinc-500">
                        <LocalDate value={at} withTime />
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
            {order.tracking_number ? (
              <p className="text-sm text-zinc-600">
                Tracking: <span className="font-medium text-zinc-950">{order.tracking_number}</span>
              </p>
            ) : canShip ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-52 flex-1">
                  <label className={labelCls} htmlFor="ship-tracking">
                    Tracking number
                  </label>
                  <input
                    id="ship-tracking"
                    className={inputCls}
                    placeholder="1Z…"
                    value={tracking}
                    onChange={(e) => setTracking(e.target.value)}
                  />
                </div>
                <button
                  className={btnPrimary}
                  disabled={busy}
                  onClick={() =>
                    run(
                      'order.ship',
                      { orderId: order.id, trackingNumber: tracking },
                      'Order marked as shipped. The customer was emailed.'
                    )
                  }
                >
                  Mark as shipped
                </button>
              </div>
            ) : order.restocked_at ? (
              <p className="text-sm text-zinc-500">
                Restocked after a refund — inventory recovery is required before this order can
                ship.
              </p>
            ) : (
              <p className="text-sm text-zinc-500">
                This order cannot be shipped in its current state ({order.status.replace(/_/g, ' ')}
                ).
              </p>
            )}
          </section>

          {/* Returns */}
          {order.returns.length > 0 ? (
            <section id="returns" className={`${cardCls} p-5 sm:p-6`}>
              <h2 className="text-sm font-medium text-zinc-950">Returns</h2>
              <ul className="mt-3 space-y-3">
                {order.returns.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 text-sm">
                    <StatusBadge value={r.status} />
                    <span className="text-zinc-600">
                      {r.reason || 'No reason given'}
                      {r.items.length > 0 ? (
                        <span className="block">
                          {r.items.map((i) => `${i.qty} × ${i.title}`).join(', ')}
                        </span>
                      ) : null}
                      {refundedAmountFor(r.id) > 0 ? (
                        <span className="block">
                          Refunded {order.currency}{' '}
                          {formatMoney(refundedAmountFor(r.id), order.currency)}
                        </span>
                      ) : null}
                      {order.refunds.find((f) => f.return_id === r.id) ? (
                        <span className="block">
                          Refund:{' '}
                          {refundStatusLabel(
                            order.refunds.find((f) => f.return_id === r.id)!.status
                          )}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-zinc-400">
                      <LocalDate value={r.created_at} />
                    </span>
                    {r.status === 'refund_failed' ? (
                      <span className="text-red-700">Refund failed — needs attention</span>
                    ) : null}
                    {r.status === 'approved' || r.status === 'refund_failed' ? (
                      <span className="ml-auto flex items-center gap-1">
                        <input
                          inputMode="decimal"
                          aria-label={`Refund amount for return ${r.id}`}
                          className="w-24 rounded-lg border border-zinc-300 px-2 py-1.5 text-sm"
                          placeholder={(calculatedFor(r) / 100).toFixed(2)}
                          value={returnAmounts[r.id] ?? (calculatedFor(r) / 100).toFixed(2)}
                          onChange={(e) =>
                            setReturnAmounts({ ...returnAmounts, [r.id]: e.target.value })
                          }
                        />
                        <button
                          className={btnSmall}
                          disabled={
                            busy ||
                            !order.permissions.refund ||
                            refundable <= 0 ||
                            order.refunds.some(
                              (f) =>
                                f.return_id === r.id && !['failed', 'canceled'].includes(f.status)
                            )
                          }
                          onClick={() => {
                            const cents = Math.round(
                              Number(returnAmounts[r.id] ?? (calculatedFor(r) / 100).toFixed(2)) *
                                100
                            );
                            if (!Number.isSafeInteger(cents) || cents < 1 || cents > refundable) {
                              setMsg({
                                kind: 'error',
                                message: 'Enter an amount within the available refund balance.',
                              });
                              return;
                            }
                            setPendingConfirm({
                              request: {
                                title: 'Refund this return?',
                                body: `Refund ${order.currency} ${formatMoney(cents, order.currency)} for this return now? You can submit a refund once. Settlement is reported separately.`,
                                confirmLabel: 'Refund this return',
                              },
                              run: () =>
                                void run(
                                  'return.refund',
                                  { returnId: r.id, amountCents: cents },
                                  'Refund submitted.'
                                ),
                            });
                          }}
                        >
                          Refund this return
                        </button>
                        {r.status === 'refund_failed' ? (
                          <button
                            className={btnSmall}
                            disabled={
                              busy ||
                              !order.permissions.refund ||
                              order.refunds.some(
                                (f) =>
                                  f.return_id === r.id && !['failed', 'canceled'].includes(f.status)
                              )
                            }
                            onClick={() => {
                              setPendingConfirm({
                                request: {
                                  title: 'Close this return?',
                                  body: 'Close this return without a refund? This frees the order for other refunds.',
                                  confirmLabel: 'Close return',
                                },
                                run: () =>
                                  void run('return.reject', { returnId: r.id }, 'Return closed.'),
                              });
                            }}
                          >
                            Close without refund
                          </button>
                        ) : null}
                      </span>
                    ) : null}
                    {r.status === 'requested' ? (
                      <span className="ml-auto flex gap-1">
                        <button
                          className={btnSmall}
                          disabled={
                            busy ||
                            !order.permissions.approve ||
                            order.refunds.some(
                              (f) =>
                                f.return_id === r.id && !['failed', 'canceled'].includes(f.status)
                            )
                          }
                          onClick={() => {
                            void run('return.approve', { returnId: r.id }, 'Return approved.');
                          }}
                        >
                          Approve return
                        </button>
                        <button
                          className={btnSmall}
                          disabled={
                            busy ||
                            !order.permissions.reject ||
                            order.refunds.some(
                              (f) =>
                                f.return_id === r.id && !['failed', 'canceled'].includes(f.status)
                            )
                          }
                          onClick={() =>
                            run('return.reject', { returnId: r.id }, 'Return rejected.')
                          }
                        >
                          Reject
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="space-y-5">
          {/* Customer */}
          <section className={`${cardCls} p-5`}>
            <h2 className="text-sm font-medium text-zinc-950">Customer</h2>
            <p className="mt-2 text-sm text-zinc-950">
              {order.shipping_name || order.customer_email}
            </p>
            <p className="text-sm text-zinc-500">{order.customer_email}</p>
            {addressLines.length > 0 ? (
              <address className="mt-3 text-sm leading-6 text-zinc-600 not-italic">
                {addressLines.map((l) => (
                  <span key={l} className="block">
                    {l}
                  </span>
                ))}
              </address>
            ) : (
              <p className="mt-3 text-sm text-zinc-500">
                No shipping address collected (digital order, or address is held by Stripe).
              </p>
            )}
          </section>

          {/* Payment / refund */}
          <section id="payment" className={`${cardCls} p-5`}>
            <h2 className="text-sm font-medium text-zinc-950">Payment</h2>
            <p className="mt-2 text-sm text-zinc-600">
              Status:{' '}
              <span className="font-medium text-zinc-950">
                {order.payment_status.replace(/_/g, ' ')}
              </span>
              {order.stripe_payment_intent_id ? (
                <span className="block truncate text-[13px] text-zinc-400">
                  Stripe {order.stripe_payment_intent_id}
                </span>
              ) : null}
            </p>
            {order.refunds.length > 0 ? (
              <ul className="mt-3 space-y-1.5 border-t border-zinc-100 pt-3 text-sm">
                {order.refunds.map((r) => (
                  <li key={r.id} className="flex justify-between">
                    <span className="text-zinc-500">
                      <LocalDate value={r.created_at} /> · {refundStatusLabel(r.status)}
                    </span>
                    <span className="font-medium">
                      −{formatMoney(r.amount_cents, order.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {hasOpenReturn ? (
              <p className="mt-4 border-t border-zinc-100 pt-4 text-sm text-zinc-500">
                This order has an open return. Refund it from the return.
              </p>
            ) : canRefund ? (
              <div className="mt-4 border-t border-zinc-100 pt-4">
                <label className={labelCls} htmlFor="refund-amount">
                  Refund amount ({order.currency}, blank = remaining balance)
                </label>
                <div className="flex gap-2">
                  <input
                    id="refund-amount"
                    inputMode="decimal"
                    className={inputCls}
                    placeholder={(refundable / 100).toFixed(2)}
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                  />
                  <button
                    className={btnSecondary}
                    disabled={busy}
                    onClick={async () => {
                      const cents = refundAmount
                        ? Math.round(Number(refundAmount) * 100)
                        : refundable;
                      if (!Number.isSafeInteger(cents) || cents < 1 || cents > refundable) {
                        setMsg({
                          kind: 'error',
                          message: 'Enter an amount within the available refund balance.',
                        });
                        return;
                      }
                      setPendingConfirm({
                        request: {
                          title: 'Refund this order?',
                          body: `Refund ${formatMoney(cents, order.currency)} for ${order.number}? This cannot be undone. Settlement is reported separately from submission.`,
                          confirmLabel: 'Refund order',
                        },
                        run: () =>
                          void run(
                            'order.refund',
                            { orderId: order.id, amountCents: cents },
                            `Refund submitted for ${formatMoney(cents, order.currency)}.`
                          ),
                      });
                    }}
                  >
                    Refund
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </div>
      <ConfirmDialog
        request={pendingConfirm?.request ?? null}
        busy={busy}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const action = pendingConfirm?.run;
          setPendingConfirm(null);
          action?.();
        }}
      />
      <section id="packing-slip" className={`${cardCls} mt-5 p-5 print:shadow-none`}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-medium text-zinc-950">Packing slip</h2>
          <button
            type="button"
            className={`${btnSmall} print:hidden`}
            onClick={() => window.print()}
          >
            Print packing slip
          </button>
        </div>
        <p className="mt-2 text-sm text-zinc-600">
          Order {order.number} · Placed <LocalDate value={order.created_at} />
        </p>
        {order.shipping_name ? (
          <p className="mt-2 text-sm text-zinc-950">{order.shipping_name}</p>
        ) : null}
        {addressLines.length > 0 ? (
          <address className="text-sm leading-6 text-zinc-600 not-italic">
            {addressLines.map((l) => (
              <span key={l} className="block">
                {l}
              </span>
            ))}
          </address>
        ) : null}
        <ul className="mt-3 divide-y divide-zinc-100 text-sm">
          {order.items.map((i) => (
            <li key={i.id} className="flex justify-between py-2">
              <span>
                {i.title} <span className="text-zinc-500">({i.sku})</span>
              </span>
              <span>Qty {i.qty}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[13px] text-zinc-500">
          This slip lists what to pack and where to send it. It carries no prices, payment details,
          or customer email.
        </p>
      </section>
    </main>
  );
}

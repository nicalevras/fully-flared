import { useState } from 'react';
import { staffMiddleware } from '../../../server/staff-middleware';
import { requireStaffPermission } from '../../../server/session';
import { LocalDate } from '../../../components/LocalDate';
import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useAdminAction } from '../../../components/AdminNav';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../../components/AdminActionFeedback';
import { formatMoney } from '../../../components/ProductCard';
import { StatusBadge } from '../../../components/StatusBadge';
import { adminOrderDiscovery } from '../../../server/admin-order-discovery';
import { orderDiscoveryInputSchema } from '../../../server/admin-order-discovery';
import { normalizeOrderSearch, type OrderView } from '../../../lib/order-search';
import { validateServerInput } from '../../../server/function-boundary';
import { roles, type StaffRole } from '../../../lib/permissions';
import { refundActionMessage } from '../../../lib/order-actions';
import {
  btnPrimary,
  btnSmall,
  cardCls,
  inputCls,
  labelCls,
  pageSub,
  pageTitle,
  tableCls,
  tableWrap,
} from '../../../components/ui';

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(orderDiscoveryInputSchema))
  .handler(async ({ data, context }) => {
    requireStaffPermission(context.staff, 'order', 'view');
    const { env } = await import('cloudflare:workers');
    const role = roles[context.staff.role as StaffRole];
    return {
      ...(await adminOrderDiscovery(env.DB, data)),
      canRefund: role?.authorize({ order: ['refund'] }).success ?? false,
      canApprove: role?.authorize({ return: ['approve'] }).success ?? false,
      canReject: role?.authorize({ return: ['reject'] }).success ?? false,
    };
  });

export const Route = createFileRoute('/admin/orders/')({
  validateSearch: (search: Record<string, unknown>) => normalizeOrderSearch(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getData({ data: deps }),
  component: AdminOrders,
});

function AdminOrders() {
  const adminAction = useAdminAction();

  const { orders, returns, nextCursor, previousCursor, canRefund, canApprove, canReject } =
    Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [query, setQuery] = useState(search.q);
  const [payment, setPayment] = useState(search.payment);
  const [from, setFrom] = useState(search.from);
  const [to, setTo] = useState(search.to);
  const requested = returns;
  const [busyId, setBusyId] = useState('');
  const [msg, setMsg] = useState<AdminActionFeedbackState>(null);

  return (
    <main>
      <h1 className={pageTitle}>Orders</h1>
      <p className={pageSub}>
        Find an order by number or customer email, work the paid and unfulfilled queue, and open an
        order for items, address, shipping, and refunds. Fulfillment is read from the order status.
        Paid and processing orders are unfulfilled.
      </p>
      <AdminActionFeedback value={msg} />

      <form
        className={`${cardCls} mt-5 flex flex-wrap items-end gap-3 p-4`}
        onSubmit={(event) => {
          event.preventDefault();
          void navigate({
            search: { q: query.trim(), view: search.view, payment, from, to },
          });
        }}
      >
        <div className="min-w-48 flex-1">
          <label className={labelCls} htmlFor="order-q">
            Order number or customer email
          </label>
          <input
            id="order-q"
            className={inputCls}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="FF-1001 or ada@example.com"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="order-view">
            View
          </label>
          <select
            id="order-view"
            className={inputCls}
            value={search.view}
            onChange={(event) =>
              void navigate({
                search: {
                  q: query.trim(),
                  view: event.target.value as OrderView,
                  payment,
                  from,
                  to,
                },
              })
            }
          >
            <option value="queue">Paid and unfulfilled</option>
            <option value="all">All orders</option>
            <option value="payment-issues">Payment issues</option>
            <option value="returns">Return requests</option>
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="order-payment">
            Payment
          </label>
          <select
            id="order-payment"
            className={inputCls}
            value={payment}
            onChange={(event) => setPayment(event.target.value as typeof payment)}
          >
            <option value="all">Any payment state</option>
            <option value="unpaid">Unpaid</option>
            <option value="paid">Paid</option>
            <option value="failed">Failed</option>
            <option value="refunded">Refunded</option>
            <option value="partially_refunded">Partially refunded</option>
            <option value="disputed">Disputed</option>
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="order-from">
            From
          </label>
          <input
            id="order-from"
            type="date"
            className={inputCls}
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="order-to">
            To
          </label>
          <input
            id="order-to"
            type="date"
            className={inputCls}
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        <button type="submit" className={btnPrimary}>
          Search
        </button>
        <nav className="flex gap-2" aria-label="Orders pagination">
          <button
            type="button"
            className={btnSmall}
            disabled={!previousCursor}
            onClick={() =>
              previousCursor && void navigate({ search: { ...search, cursor: previousCursor } })
            }
          >
            Previous
          </button>
          <button
            type="button"
            className={btnSmall}
            disabled={!nextCursor}
            onClick={() =>
              nextCursor && void navigate({ search: { ...search, cursor: nextCursor } })
            }
          >
            Next
          </button>
        </nav>
      </form>
      <section className={`${cardCls} mt-6 overflow-hidden`}>
        {orders.length === 0 ? (
          <p className="p-5 text-sm text-zinc-500" role="status">
            {search.view === 'queue'
              ? 'Nothing is waiting to be fulfilled in this view.'
              : 'No orders match this search.'}{' '}
            <button
              type="button"
              className="underline"
              onClick={() => {
                setQuery('');
                setPayment('all');
                setFrom('');
                setTo('');
                void navigate({ search: { q: '', view: 'all', payment: 'all', from: '', to: '' } });
              }}
            >
              Clear the search and filters
            </button>
          </p>
        ) : (
          <div className={tableWrap}>
            <table className={tableCls}>
              <caption className="sr-only">Orders</caption>
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Fulfillment</th>
                  <th scope="col">Payment</th>
                  <th scope="col">Date</th>
                  <th scope="col" className="text-right">
                    Total
                  </th>
                  <th scope="col" className="text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="font-medium">
                      <Link
                        to="/admin/orders/$id"
                        params={{ id: o.id }}
                        className="text-zinc-950 hover:underline"
                      >
                        {o.number}
                      </Link>
                    </td>
                    <td className="text-zinc-500">{o.customer_email}</td>
                    <td>
                      <StatusBadge value={o.status} />
                    </td>
                    <td>
                      <StatusBadge value={o.payment_status} />
                    </td>
                    <td className="text-zinc-500">
                      <LocalDate value={o.created_at} />
                    </td>
                    <td className="text-right font-medium">
                      {formatMoney(o.total_cents, o.currency)}
                    </td>
                    <td className="text-right">
                      <span className="inline-flex gap-1">
                        <Link to="/admin/orders/$id" params={{ id: o.id }} className={btnSmall}>
                          View
                        </Link>
                        <button
                          className={btnSmall}
                          title={
                            o.has_open_return
                              ? 'This order has an open return. Refund it from the return.'
                              : undefined
                          }
                          disabled={
                            !!busyId ||
                            !canRefund ||
                            !!o.has_open_return ||
                            !['paid', 'partially_refunded'].includes(o.payment_status) ||
                            o.refundable_cents <= 0
                          }
                          onClick={async () => {
                            if (
                              !window.confirm(
                                `Refund ${o.number} remaining balance (${o.currency} ${formatMoney(o.refundable_cents, o.currency)})? This cannot be undone.`
                              )
                            )
                              return;
                            setMsg(null);
                            setBusyId(o.id);
                            const r = await adminAction('order.refund', {
                              orderId: o.id,
                              amountCents: o.refundable_cents,
                            });
                            setBusyId('');
                            if (r.ok) {
                              setMsg({
                                kind: 'status',
                                message: refundActionMessage(r.data, o.currency),
                              });
                              router.invalidate();
                            } else setMsg({ kind: 'error', message: r.error ?? 'Refund failed' });
                          }}
                        >
                          {busyId === o.id ? 'Refunding…' : 'Refund'}
                        </button>
                      </span>
                      {o.has_open_return ? (
                        <span className="block text-[12px] text-zinc-400">
                          Open return — refund from the return
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {search.view === 'returns' && requested.length > 0 ? (
        <section className={`${cardCls} mt-5 overflow-hidden`}>
          <h2 className="px-5 pt-4 pb-3 text-sm font-medium text-zinc-950">Return requests</h2>
          <div className={tableWrap}>
            <table className={tableCls}>
              <caption className="sr-only">Return requests</caption>
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Requested</th>
                  <th scope="col" className="text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {requested.map((r) => (
                  <tr key={r.id}>
                    <td className="font-medium">
                      <Link
                        to="/admin/orders/$id"
                        params={{ id: r.order_id }}
                        className="hover:underline"
                      >
                        {r.number}
                      </Link>
                    </td>
                    <td className="text-zinc-500">
                      {r.reason || 'No reason given'}
                      <span className="block">
                        <StatusBadge value={r.status} />
                        {r.status === 'refund_failed' ? (
                          <span className="text-red-700"> Refund failed — needs attention</span>
                        ) : null}
                      </span>
                      {r.refund_status ? (
                        <span className="block">Refund: {r.refund_status.replace(/_/g, ' ')}</span>
                      ) : null}
                      {r.total_cents > 0 ? (
                        <span className="block">
                          {r.currency} {formatMoney(r.refundable_cents, r.currency)} available to
                          refund
                        </span>
                      ) : null}
                    </td>
                    <td className="text-zinc-500">
                      <LocalDate value={r.created_at} />
                    </td>
                    <td className="text-right">
                      <span className="inline-flex gap-1">
                        {r.status === 'requested' ? (
                          <button
                            className={btnSmall}
                            disabled={
                              !!busyId ||
                              !canApprove ||
                              (!!r.refund_status &&
                                !['failed', 'canceled'].includes(r.refund_status))
                            }
                            onClick={async () => {
                              setMsg(null);
                              setBusyId(r.id);
                              const res = await adminAction('return.approve', {
                                returnId: r.id,
                              });
                              setBusyId('');
                              if (res.ok) {
                                setMsg({ kind: 'status', message: 'Return approved.' });
                                router.invalidate();
                              } else setMsg({ kind: 'error', message: res.error ?? 'Failed' });
                            }}
                          >
                            Approve return
                          </button>
                        ) : null}
                        <button
                          className={btnSmall}
                          disabled={
                            !!busyId ||
                            !canReject ||
                            (!!r.refund_status && !['failed', 'canceled'].includes(r.refund_status))
                          }
                          onClick={async () => {
                            setMsg(null);
                            setBusyId(r.id);
                            const res = await adminAction('return.reject', { returnId: r.id });
                            setBusyId('');
                            if (res.ok) {
                              setMsg({
                                kind: 'status',
                                message: `Return for ${r.number} rejected.`,
                              });
                              router.invalidate();
                            } else setMsg({ kind: 'error', message: res.error ?? 'Failed' });
                          }}
                        >
                          {r.status === 'refund_failed' ? 'Close without refund' : 'Reject'}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </main>
  );
}

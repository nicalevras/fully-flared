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
import { adminOrders } from '../../../server/admin-lists';
import { orderPagesSchema } from '../../../schemas/pagination';
import { orderPagesSearch } from '../../../lib/search-params';
import { validateServerInput } from '../../../server/function-boundary';
import { AdminPager } from '../../../components/AdminPager';
import { roles, type StaffRole } from '../../../lib/permissions';
import { refundActionMessage } from '../../../lib/order-actions';
import { btnSmall, cardCls, pageSub, pageTitle, tableCls, tableWrap } from '../../../components/ui';

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(orderPagesSchema))
  .handler(async ({ data, context }) => {
    requireStaffPermission(context.staff, 'order', 'view');
    const { env } = await import('cloudflare:workers');
    const role = roles[context.staff.role as StaffRole];
    return {
      ...(await adminOrders(env.DB, data)),
      canRefund: role?.authorize({ order: ['refund'] }).success ?? false,
      canApprove: role?.authorize({ return: ['approve'] }).success ?? false,
      canReject: role?.authorize({ return: ['reject'] }).success ?? false,
    };
  });

export const Route = createFileRoute('/admin/orders/')({
  validateSearch: orderPagesSearch,
  loaderDeps: ({ search }) => ({ page: search.page, returnsPage: search.returnsPage }),
  loader: async ({ deps }) => getData({ data: deps }),
  component: AdminOrders,
});

function AdminOrders() {
  const adminAction = useAdminAction();

  const {
    orders,
    returns,
    totalOrders,
    totalReturns,
    page,
    returnsPage,
    canRefund,
    canApprove,
    canReject,
  } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const requested = returns.filter((r) => ['requested', 'refund_failed'].includes(r.status));
  const [busyId, setBusyId] = useState('');
  const [msg, setMsg] = useState<AdminActionFeedbackState>(null);

  return (
    <main>
      <h1 className={pageTitle}>Orders</h1>
      <p className={pageSub}>
        {totalOrders} order{totalOrders === 1 ? '' : 's'}
        {totalOrders > orders.length ? `, showing ${orders.length} on this page` : ''}. Click an
        order for items, address, shipping, and refunds.
      </p>
      <AdminActionFeedback value={msg} />

      <AdminPager
        label="Orders pagination"
        page={page}
        total={totalOrders}
        pageSize={100}
        onPage={(page) => {
          void navigate({ search: (prev) => ({ ...prev, page }) });
        }}
      />
      <section className={`${cardCls} mt-6 overflow-hidden`}>
        {orders.length === 0 ? (
          <p className="p-5 text-sm text-zinc-500" role="status">
            No orders yet.
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

      <AdminPager
        label="Pending returns pagination"
        page={returnsPage}
        total={totalReturns}
        pageSize={50}
        onPage={(returnsPage) => {
          void navigate({ search: (prev) => ({ ...prev, returnsPage }) });
        }}
      />
      {requested.length > 0 ? (
        <section className={`${cardCls} mt-5 overflow-hidden`}>
          <h2 className="px-5 pt-4 pb-3 text-sm font-medium text-zinc-950">
            Return requests ({totalReturns})
          </h2>
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

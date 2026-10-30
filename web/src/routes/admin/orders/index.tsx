import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table';
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
import { isOrderPaymentFilter, isOrderView, normalizeOrderSearch } from '../../../lib/order-search';
import { validateServerInput } from '../../../server/function-boundary';
import { roleFor } from '../../../lib/permissions';
import { canShipOrder, refundActionMessage } from '../../../lib/order-actions';
import { ConfirmDialog, type ConfirmRequest } from '../../../components/ConfirmDialog';
import {
  applyBulkOutcome,
  bulkTrackingErrors,
  createBulkItems,
  retryableBulkItems,
  setBulkTracking,
  summarizeBulk,
  MAX_BULK_FULFILLMENT,
  type BulkFulfillmentItem,
} from '../../../lib/bulk-fulfillment';
import {
  btnPrimary,
  btnSmall,
  cardCls,
  inputCls,
  pageSub,
  pageTitle,
} from '../../../components/ui';
import { AdminDataTableShell } from '../../../components/AdminDataTable';
import { Checkbox } from '../../../components/ui/checkbox';
import type { ColumnDef, OnChangeFn, RowSelectionState } from '@tanstack/react-table';
import {
  DataTable,
  DataTableSearch,
  dataTableControlClassName,
  dataTableMenuClassName,
  dataTableMenuItemClassName,
} from '../../../components/ui/data-table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import type { DataTableFeatures } from '../../../components/data-table-features';

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(orderDiscoveryInputSchema))
  .handler(async ({ data, context }) => {
    requireStaffPermission(context.staff, 'order', 'view');
    const { env } = await import('cloudflare:workers');
    const role = roleFor(context.staff.role);
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

  const {
    orders,
    returns,
    nextCursor,
    previousCursor,
    returnsNextCursor,
    returnsPreviousCursor,
    canRefund,
    canApprove,
    canReject,
  } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const requested = returns;
  const [busyId, setBusyId] = useState('');
  const [msg, setMsg] = useState<AdminActionFeedbackState>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkItems, setBulkItems] = useState<BulkFulfillmentItem[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [refundTarget, setRefundTarget] = useState<(typeof orders)[number] | null>(null);
  const [returnDecision, setReturnDecision] = useState<{
    action: 'return.approve' | 'return.reject';
    returnRow: (typeof returns)[number];
    request: ConfirmRequest;
    done: string;
  } | null>(null);

  async function decideReturn(decision: NonNullable<typeof returnDecision>) {
    setMsg(null);
    setBusyId(decision.returnRow.id);
    const res = await adminAction(decision.action, { returnId: decision.returnRow.id });
    setBusyId('');
    if (res.ok) {
      setMsg({ kind: 'status', message: decision.done });
      router.invalidate();
    } else setMsg({ kind: 'error', message: res.error ?? 'Failed' });
  }

  async function runBulk(itemsToRun: BulkFulfillmentItem[]) {
    const errors = bulkTrackingErrors(itemsToRun);
    if (errors.length > 0) {
      setMsg({ kind: 'error', message: errors.join(' ') });
      return;
    }
    setBulkBusy(true);
    let current = bulkItems ?? itemsToRun;
    for (const item of itemsToRun) {
      const result = await adminAction('order.ship', {
        orderId: item.orderId,
        trackingNumber: item.tracking.trim(),
      });
      current = applyBulkOutcome(current, item.orderId, {
        ok: result.ok,
        message: result.ok ? 'Shipped. The customer was emailed.' : result.error,
      });
      setBulkItems(current);
    }
    setBulkBusy(false);
    const summary = summarizeBulk(current);
    if (summary.complete) {
      setMsg({ kind: 'status', message: `All ${summary.total} orders shipped.` });
      setSelected([]);
    } else if (summary.partial) {
      setMsg({
        kind: 'error',
        message: `${summary.applied} of ${summary.total} orders shipped. Retry only the failed orders. Shipped orders are not sent again.`,
      });
    } else {
      setMsg({ kind: 'error', message: 'No orders were shipped. Review the results below.' });
    }
    router.invalidate();
  }

  type OrderRow = (typeof orders)[number];

  const rowSelection: RowSelectionState = Object.fromEntries(
    selected.map((id) => [id, true] as const)
  );
  const handleRowSelectionChange: OnChangeFn<RowSelectionState> = (updater) => {
    const next = typeof updater === 'function' ? updater(rowSelection) : updater;
    setBulkItems(null);
    setSelected(Object.keys(next).filter((id) => next[id]));
  };

  const selectColumn: ColumnDef<DataTableFeatures, OrderRow> = {
    id: 'select',
    header: () => <span className="sr-only">Select for bulk shipping</span>,
    enableHiding: false,
    cell: ({ row }) => {
      const o = row.original;
      return (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          disabled={
            !canShipOrder(o) ||
            (!selected.includes(o.id) && selected.length >= MAX_BULK_FULFILLMENT)
          }
          aria-label={`Select ${o.number} for bulk shipping`}
        />
      );
    },
  };
  const orderColumns: ColumnDef<DataTableFeatures, OrderRow>[] = [
    ...(search.view === 'queue' ? [selectColumn] : []),
    {
      id: 'order',
      accessorKey: 'number',
      header: 'Order',
      enableHiding: false,
      cell: ({ row }) => (
        <Link
          to="/admin/orders/$id"
          params={{ id: row.original.id }}
          className="font-medium text-zinc-950 hover:underline"
        >
          {row.original.number}
        </Link>
      ),
    },
    {
      id: 'customer',
      accessorKey: 'customer_email',
      header: 'Customer',
      cell: ({ row }) => <span className="text-zinc-500">{row.original.customer_email}</span>,
    },
    {
      id: 'fulfillment',
      accessorKey: 'status',
      header: 'Fulfillment',
      cell: ({ row }) => <StatusBadge value={row.original.status} />,
    },
    {
      id: 'payment',
      accessorKey: 'payment_status',
      header: 'Payment',
      cell: ({ row }) => <StatusBadge value={row.original.payment_status} />,
    },
    {
      id: 'date',
      accessorKey: 'created_at',
      header: 'Date',
      cell: ({ row }) => (
        <span className="text-zinc-500">
          <LocalDate value={row.original.created_at} />
        </span>
      ),
    },
    {
      id: 'total',
      accessorKey: 'total_cents',
      header: () => <div className="text-right">Total</div>,
      cell: ({ row }) => (
        <div className="text-right font-medium">
          {formatMoney(row.original.total_cents, row.original.currency)}
        </div>
      ),
    },
    {
      id: 'actions',
      header: () => <div className="text-right">Actions</div>,
      enableHiding: false,
      cell: ({ row }) => {
        const o = row.original;
        return (
          <div className="text-right">
            <span className="inline-flex gap-1">
              <Link to="/admin/orders/$id" params={{ id: o.id }} className={btnSmall}>
                View
              </Link>
              <button
                type="button"
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
                onClick={() => setRefundTarget(o)}
              >
                {busyId === o.id ? 'Refunding…' : 'Refund'}
              </button>
            </span>
            {o.has_open_return ? (
              <span className="block text-[12px] text-zinc-400">
                Open return — refund from the return
              </span>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <main>
      <h1 className={pageTitle}>Orders</h1>
      <p className={pageSub}>
        Find an order by number, work the queue, and open it for items, shipping, and refunds.
      </p>
      <AdminActionFeedback value={msg} />

      <section className="mt-6">
        <DataTable
          caption="Orders"
          emptyMessage={
            <p className="p-5 text-sm text-zinc-500" role="status">
              {search.view === 'queue'
                ? 'Nothing is waiting to be fulfilled in this view.'
                : 'No orders match this search.'}{' '}
              <button
                type="button"
                className="underline"
                onClick={() =>
                  void navigate({
                    search: {
                      q: '',
                      mode: 'number',
                      view: 'all',
                      payment: 'all',
                      from: '',
                      to: '',
                    },
                  })
                }
              >
                Clear the search and filters
              </button>
            </p>
          }
          columns={orderColumns}
          data={orders}
          pageIndex={0}
          pageSize={50}
          rowCount={0}
          onPaginationChange={() => undefined}
          getRowId={(o) => o.id}
          rowSelection={rowSelection}
          onRowSelectionChange={handleRowSelectionChange}
          toolbar={
            <DataTableSearch
              value={search.q}
              onSearch={(q) => void navigate({ search: { ...search, q, cursor: undefined } })}
              placeholder="FF-1001"
              ariaLabel="Order number"
            />
          }
          toolbarActions={
            <>
              <Select
                value={search.view}
                onValueChange={(value) => {
                  if (isOrderView(value))
                    void navigate({ search: { ...search, view: value, cursor: undefined } });
                }}
              >
                <SelectTrigger aria-label="View" className={dataTableControlClassName}>
                  <SelectValue>View</SelectValue>
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  align="end"
                  sideOffset={4}
                  className={dataTableMenuClassName}
                >
                  <SelectItem className={dataTableMenuItemClassName} value="queue">
                    Paid and unfulfilled
                  </SelectItem>
                  <SelectItem className={dataTableMenuItemClassName} value="all">
                    All orders
                  </SelectItem>
                  <SelectItem className={dataTableMenuItemClassName} value="payment-issues">
                    Payment issues
                  </SelectItem>
                  <SelectItem className={dataTableMenuItemClassName} value="returns">
                    Return requests
                  </SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={search.payment}
                onValueChange={(value) => {
                  if (isOrderPaymentFilter(value))
                    void navigate({ search: { ...search, payment: value, cursor: undefined } });
                }}
              >
                <SelectTrigger aria-label="Payment" className={dataTableControlClassName}>
                  <SelectValue>Payment</SelectValue>
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  align="end"
                  sideOffset={4}
                  className={dataTableMenuClassName}
                >
                  <SelectItem className={dataTableMenuItemClassName} value="all">
                    Any payment state
                  </SelectItem>
                  <SelectItem className={dataTableMenuItemClassName} value="unpaid">
                    Unpaid
                  </SelectItem>
                  <SelectItem className={dataTableMenuItemClassName} value="paid">
                    Paid
                  </SelectItem>
                  <SelectItem className={dataTableMenuItemClassName} value="failed">
                    Failed
                  </SelectItem>
                  <SelectItem className={dataTableMenuItemClassName} value="refunded">
                    Refunded
                  </SelectItem>
                  <SelectItem className={dataTableMenuItemClassName} value="partially_refunded">
                    Partially refunded
                  </SelectItem>
                  <SelectItem className={dataTableMenuItemClassName} value="disputed">
                    Disputed
                  </SelectItem>
                </SelectContent>
              </Select>
              <input
                type="date"
                aria-label="From"
                className={dataTableControlClassName}
                value={search.from}
                onChange={(event) =>
                  void navigate({
                    search: { ...search, from: event.target.value, cursor: undefined },
                  })
                }
              />
              <input
                type="date"
                aria-label="To"
                className={dataTableControlClassName}
                value={search.to}
                onChange={(event) =>
                  void navigate({
                    search: { ...search, to: event.target.value, cursor: undefined },
                  })
                }
              />
            </>
          }
          paginationFooter={
            <div className="flex flex-wrap items-center gap-2 px-2 py-4">
              <p className="flex-1 text-sm text-muted-foreground" role="status">
                {search.view === 'queue'
                  ? `${selected.length} of ${orders.length} row(s) selected`
                  : ''}
              </p>
              <nav className="flex gap-2" aria-label="Orders pagination">
                <button
                  type="button"
                  className="h-8 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-950 disabled:opacity-50"
                  disabled={!previousCursor}
                  onClick={() =>
                    previousCursor &&
                    void navigate({ search: { ...search, cursor: previousCursor } })
                  }
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="h-8 rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-950 disabled:opacity-50"
                  disabled={!nextCursor}
                  onClick={() =>
                    nextCursor && void navigate({ search: { ...search, cursor: nextCursor } })
                  }
                >
                  Next
                </button>
              </nav>
            </div>
          }
        />
      </section>

      {search.view === 'queue' && (selected.length > 0 || bulkItems) ? (
        <div className="sticky bottom-4 z-40 mt-5">
          <section className={`${cardCls} p-4 shadow-lg`}>
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm font-medium text-zinc-950">
                {bulkItems
                  ? `${summarizeBulk(bulkItems).applied} of ${bulkItems.length} shipped`
                  : `${selected.length} selected for shipping`}
              </p>
              {!bulkItems ? (
                <button
                  type="button"
                  className={btnPrimary}
                  onClick={() => {
                    const rows = orders.filter((o) => selected.includes(o.id));
                    const created = createBulkItems(rows, []);
                    if (created.error) {
                      setMsg({ kind: 'error', message: created.error });
                      return;
                    }
                    setBulkItems(created.items);
                  }}
                >
                  Review shipments
                </button>
              ) : null}
              <button
                type="button"
                className={btnSmall}
                disabled={bulkBusy}
                onClick={() => {
                  setBulkItems(null);
                  setSelected([]);
                }}
              >
                Clear selection
              </button>
            </div>
            {bulkItems ? (
              <div className="mt-3">
                <div tabIndex={0} role="region" aria-label="Bulk shipments">
                  <AdminDataTableShell>
                    <Table className="min-w-[560px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead scope="col">Order</TableHead>
                          <TableHead scope="col">Tracking number</TableHead>
                          <TableHead scope="col">Result</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {bulkItems.map((item) => (
                          <TableRow key={item.orderId}>
                            <TableCell className="font-medium">{item.number}</TableCell>
                            <TableCell>
                              <input
                                className={inputCls}
                                aria-label={`Tracking number for ${item.number}`}
                                value={item.tracking}
                                disabled={item.status === 'applied' || bulkBusy}
                                onChange={(event) =>
                                  setBulkItems((prev) =>
                                    prev
                                      ? setBulkTracking(prev, item.orderId, event.target.value)
                                      : prev
                                  )
                                }
                              />
                            </TableCell>
                            <TableCell>
                              {item.status === 'pending'
                                ? 'Not shipped yet'
                                : item.status === 'applied'
                                  ? item.message
                                  : `Failed. ${item.message}`}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </AdminDataTableShell>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {summarizeBulk(bulkItems).pending > 0 ? (
                    <button
                      type="button"
                      className={btnPrimary}
                      disabled={bulkBusy}
                      onClick={() => void runBulk(retryableBulkItems(bulkItems))}
                    >
                      {bulkBusy ? 'Shipping...' : 'Ship reviewed orders'}
                    </button>
                  ) : null}
                  {summarizeBulk(bulkItems).failed > 0 ? (
                    <button
                      type="button"
                      className={btnPrimary}
                      disabled={bulkBusy}
                      onClick={() => void runBulk(retryableBulkItems(bulkItems))}
                    >
                      Retry failed orders only
                    </button>
                  ) : null}
                </div>
                {summarizeBulk(bulkItems).partial ? (
                  <p className="mt-2 text-sm text-amber-700" role="status">
                    Partial success. Shipped orders stay shipped and are never sent again. Only the
                    failed orders are retried.
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      <ConfirmDialog
        request={returnDecision?.request ?? null}
        busy={!!busyId}
        onCancel={() => setReturnDecision(null)}
        onConfirm={() => {
          const decision = returnDecision;
          setReturnDecision(null);
          if (decision) void decideReturn(decision);
        }}
      />
      <ConfirmDialog
        request={
          refundTarget
            ? {
                title: 'Refund this order?',
                body: `Refund ${refundTarget.number} remaining balance (${refundTarget.currency} ${formatMoney(refundTarget.refundable_cents, refundTarget.currency)})? This cannot be undone. Settlement is reported separately from submission.`,
                confirmLabel: 'Refund order',
              }
            : null
        }
        busy={!!busyId}
        onCancel={() => setRefundTarget(null)}
        onConfirm={async () => {
          const o = refundTarget;
          setRefundTarget(null);
          if (!o) return;
          setMsg(null);
          setBusyId(o.id);
          const r = await adminAction('order.refund', {
            orderId: o.id,
            amountCents: o.refundable_cents,
          });
          setBusyId('');
          if (r.ok) {
            setMsg({ kind: 'status', message: refundActionMessage(r.data, o.currency) });
            router.invalidate();
          } else setMsg({ kind: 'error', message: r.error ?? 'Refund failed' });
        }}
      />

      {search.view === 'returns' ? (
        <section className={`${cardCls} mt-5 overflow-hidden`}>
          <h2 className="px-5 pt-4 pb-3 text-sm font-medium text-zinc-950">Return requests</h2>
          <AdminDataTableShell>
            <Table>
              <TableCaption className="sr-only">Return requests</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Order</TableHead>
                  <TableHead scope="col">Reason</TableHead>
                  <TableHead scope="col">Requested</TableHead>
                  <TableHead scope="col" className="text-right">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requested.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center">
                      No return requests match this search.
                    </TableCell>
                  </TableRow>
                ) : null}
                {requested.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">
                      <Link
                        to="/admin/orders/$id"
                        params={{ id: r.order_id }}
                        className="hover:underline"
                      >
                        {r.number}
                      </Link>
                    </TableCell>
                    <TableCell className="text-zinc-500">
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
                    </TableCell>
                    <TableCell className="text-zinc-500">
                      <LocalDate value={r.created_at} />
                    </TableCell>
                    <TableCell className="text-right">
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
                            onClick={() =>
                              setReturnDecision({
                                action: 'return.approve',
                                returnRow: r,
                                request: {
                                  title: 'Approve this return?',
                                  body: `Approve the return for ${r.number}? The decision cannot be changed. Refunds are issued separately.`,
                                  confirmLabel: 'Approve return',
                                },
                                done: 'Return approved.',
                              })
                            }
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
                          onClick={() =>
                            setReturnDecision({
                              action: 'return.reject',
                              returnRow: r,
                              request:
                                r.status === 'refund_failed'
                                  ? {
                                      title: 'Close this return?',
                                      body: `Close the return for ${r.number} without a refund? This frees the order for other refunds.`,
                                      confirmLabel: 'Close return',
                                    }
                                  : {
                                      title: 'Reject this return?',
                                      body: `Reject the return for ${r.number}? The decision cannot be changed.`,
                                      confirmLabel: 'Reject return',
                                    },
                              done:
                                r.status === 'refund_failed'
                                  ? `Return for ${r.number} closed.`
                                  : `Return for ${r.number} rejected.`,
                            })
                          }
                        >
                          {r.status === 'refund_failed' ? 'Close without refund' : 'Reject'}
                        </button>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </AdminDataTableShell>
          <nav className="flex gap-2 px-5 py-3" aria-label="Returns pagination">
            <button
              type="button"
              className={btnSmall}
              disabled={!returnsPreviousCursor}
              onClick={() =>
                returnsPreviousCursor &&
                void navigate({ search: { ...search, returnsCursor: returnsPreviousCursor } })
              }
            >
              Previous returns
            </button>
            <button
              type="button"
              className={btnSmall}
              disabled={!returnsNextCursor}
              onClick={() =>
                returnsNextCursor &&
                void navigate({ search: { ...search, returnsCursor: returnsNextCursor } })
              }
            >
              More returns
            </button>
          </nav>
        </section>
      ) : null}
    </main>
  );
}

import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router';
import { useAdminAction } from '../../components/AdminNav';
import { staffMiddleware } from '../../server/staff-middleware';
import { requireStaffPermission } from '../../server/session';
import { useStoreCurrency } from '../../lib/use-store-currency';
import { createServerFn } from '@tanstack/react-start';
import { getSettings } from '../../server/settings';
import {
  dashboardStats,
  paidRevenueByCurrency,
  type CurrencyRevenue,
  type DashboardPeriodStats,
} from '../../server/reports';
import * as z from 'zod';
import { validateServerInput } from '../../server/function-boundary';
import { failingCatalogWork, type FailingCatalogWork } from '../../server/catalog-operations';
import { failedEmailCount } from '../../server/outbox';
import { MailIcon } from 'lucide-react';
import {
  ArrowRightIcon,
  BoxIcon,
  CheckIcon,
  FileIcon,
  OrdersIcon,
  ReturnIcon,
  ShieldIcon,
} from '../../components/icons';
import { formatMoney } from '../../components/ProductCard';
import { StatusBadge } from '../../components/StatusBadge';
import type { OrderStatus, PaymentStatus } from '../../db/schema';
import { btnPrimary, pageSub, pageTitle } from '../../components/ui';
import { AdminDataTableShell } from '../../components/AdminDataTable';
import { roleCan, roleFor } from '../../lib/permissions';

type Stats = {
  storeName: string;
  periodDays: number;
  periodStats: DashboardPeriodStats[];
  revenues: CurrencyRevenue[];
  paidOrders: number;
  pendingOrders: number;
  activeProducts: number;
  lowStockSkus: number;
  returnsPending: number;
  deadWebhooks: Array<{ event_id: string; type: string; attempts: number; received_at: string }>;
  deadWebhookCount: number;
  failedEmails: number;
  canReplay: boolean;
  catalogFailures: FailingCatalogWork;
  recent: Array<{
    id: string;
    number: string;
    customer_email: string;
    total_cents: number;
    currency: string;
    status: OrderStatus;
    payment_status: PaymentStatus;
    created_at: string;
  }>;
};

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(
    validateServerInput(z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]) }))
  )
  .handler(async ({ context, data }): Promise<Stats> => {
    requireStaffPermission(context.staff, 'report', 'view');
    const { env } = await import('cloudflare:workers');
    const db = env.DB;
    const role = roleFor(context.staff.role);
    const [
      settings,
      revenue,
      pending,
      products,
      low,
      returns,
      recent,
      deadWebhooks,
      deadCount,
      catalogFailures,
      failedEmails,
    ] = await Promise.all([
      getSettings(db),
      paidRevenueByCurrency(db),
      db
        .prepare("SELECT COUNT(*) AS n FROM orders WHERE status='pending_payment'")
        .first<{ n: number }>(),
      db.prepare("SELECT COUNT(*) AS n FROM products WHERE status='active'").first<{ n: number }>(),
      db
        .prepare('SELECT COUNT(*) AS n FROM stock WHERE on_hand - reserved <= 5')
        .first<{ n: number }>(),
      db
        .prepare("SELECT COUNT(*) AS n FROM returns WHERE status IN ('requested','refund_failed')")
        .first<{ n: number }>(),
      db
        .prepare(
          'SELECT id, number, customer_email, total_cents, currency, status, payment_status, created_at FROM orders ORDER BY created_at DESC LIMIT 5'
        )
        .all<Stats['recent'][number]>(),
      db
        .prepare(
          "SELECT event_id, type, attempts, received_at FROM webhook_inbox WHERE status IN ('dead','failed') ORDER BY received_at ASC LIMIT 10"
        )
        .all<Stats['deadWebhooks'][number]>(),
      db
        .prepare("SELECT COUNT(*) AS n FROM webhook_inbox WHERE status IN ('dead','failed')")
        .first<{ n: number }>(),
      failingCatalogWork(db),
      failedEmailCount(db),
    ]);
    const toIso = new Date().toISOString();
    const fromIso = new Date(Date.now() - data.days * 86_400_000).toISOString();
    const periodStats = await dashboardStats(db, fromIso, toIso);
    return {
      storeName: settings.storeName,
      periodDays: data.days,
      periodStats,
      revenues: revenue,
      paidOrders: revenue.reduce((sum, row) => sum + row.orders, 0),
      pendingOrders: pending?.n ?? 0,
      activeProducts: products?.n ?? 0,
      lowStockSkus: low?.n ?? 0,
      returnsPending: returns?.n ?? 0,
      recent: recent.results,
      deadWebhooks: deadWebhooks.results,
      deadWebhookCount: deadCount?.n ?? 0,
      failedEmails,
      canReplay: role?.authorize({ webhook: ['replay'] }).success ?? false,
      catalogFailures,
    };
  });

/** Staff without report access land on the orders queue instead of the dashboard. */
export function guardAdminHome({
  context,
}: {
  context: { staff?: { role?: string | null | undefined } | null | undefined };
}): void {
  if (!roleCan(context.staff?.role, 'report', 'view'))
    throw redirect({
      to: '/admin/orders',
      search: { q: '', mode: 'number', view: 'queue', payment: 'all', from: '', to: '' },
    });
}

export const Route = createFileRoute('/admin/')({
  beforeLoad: guardAdminHome,
  validateSearch: (search: Record<string, unknown>): { days?: 7 | 30 | 90 } => {
    const days = Number(search.days);
    return { days: days === 7 || days === 30 || days === 90 ? days : 30 };
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getData({ data: { days: deps.days ?? 30 } }),
  component: AdminHome,
});

function AdminHome() {
  const currency = useStoreCurrency();
  const s = Route.useLoaderData();
  const router = useRouter();
  const adminAction = useAdminAction();
  const [replaying, setReplaying] = useState<string | null>(null);
  const [replayError, setReplayError] = useState('');
  const replay = async (eventId: string) => {
    setReplaying(eventId);
    setReplayError('');
    const r = await adminAction('webhook.replay', { eventId });
    setReplaying(null);
    if (!r.ok) {
      setReplayError('Replay could not be queued. The event stays quarantined.');
      return;
    }
    void router.invalidate();
  };
  const revenueRows = s.revenues.length ? s.revenues : [{ currency, revenue: 0, orders: 0 }];
  const hasAttention =
    s.returnsPending > 0 ||
    s.lowStockSkus > 0 ||
    s.pendingOrders > 0 ||
    s.deadWebhookCount > 0 ||
    s.failedEmails > 0 ||
    s.catalogFailures.count > 0;
  const pillWhite =
    'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border border-zinc-300 bg-white px-4 text-[13px] font-medium text-zinc-950 transition-colors hover:border-zinc-950 disabled:pointer-events-none disabled:opacity-40';
  const tileCls =
    'group rounded-xl border border-zinc-200 bg-white p-4 transition-colors hover:border-zinc-400';
  return (
    <main>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className={pageTitle}>Welcome, {s.storeName}</h1>
          <p className={pageSub}>Here is what needs your attention, and how the store is doing.</p>
        </div>
        <Link to="/admin/products" className={btnPrimary}>
          + Add product
        </Link>
      </div>

      <section aria-labelledby="needs-attention" className="mt-10">
        <h2 id="needs-attention" className="text-[15px] font-medium text-zinc-950">
          Needs attention
        </h2>
        <div className="mt-3 divide-y divide-zinc-950/[0.06] rounded-2xl bg-zinc-50 px-5 py-1">
          {!hasAttention && (
            <div className="flex items-center gap-4 py-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-zinc-950">
                <CheckIcon className="h-[18px] w-[18px]" />
              </span>
              <div>
                <p className="text-sm font-medium text-zinc-950">All caught up</p>
                <p className="text-[13px] text-zinc-500">Nothing needs your attention right now.</p>
              </div>
            </div>
          )}
          {s.returnsPending > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-[#ff4d00]">
                <ReturnIcon className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0 flex-1 basis-56">
                <p className="text-sm font-medium text-zinc-950">
                  {s.returnsPending} return{s.returnsPending === 1 ? '' : 's'} to review
                </p>
                <p className="text-[13px] text-zinc-500">
                  Requested, plus failed refunds needing attention.
                </p>
              </div>
              <Link
                to="/admin/orders"
                search={{
                  q: '',
                  mode: 'number',
                  view: 'returns',
                  payment: 'all',
                  from: '',
                  to: '',
                }}
                className={pillWhite}
              >
                Review
              </Link>
            </div>
          )}
          {s.lowStockSkus > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-[#ff4d00]">
                <BoxIcon className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0 flex-1 basis-56">
                <p className="text-sm font-medium text-zinc-950">
                  {s.lowStockSkus} SKU{s.lowStockSkus === 1 ? ' is' : 's are'} running low
                </p>
                <p className="text-[13px] text-zinc-500">
                  5 or fewer available. Restock before they sell out.
                </p>
              </div>
              <Link
                to="/admin/inventory"
                search={{
                  q: '',
                  page: 1,
                  low: false,
                  sku: undefined,
                  size: undefined,
                }}
                className={pillWhite}
              >
                Review inventory
              </Link>
            </div>
          )}
          {s.pendingOrders > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-[#ff4d00]">
                <OrdersIcon className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0 flex-1 basis-56">
                <p className="text-sm font-medium text-zinc-950">
                  {s.pendingOrders} order{s.pendingOrders === 1 ? '' : 's'} awaiting payment
                </p>
                <p className="text-[13px] text-zinc-500">
                  Payment has not completed for these orders yet.
                </p>
              </div>
              <Link
                to="/admin/orders"
                search={{
                  q: '',
                  mode: 'number',
                  view: 'payment-issues',
                  payment: 'all',
                  from: '',
                  to: '',
                }}
                className={pillWhite}
              >
                Review
              </Link>
            </div>
          )}
          {s.failedEmails > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-[#ff4d00]">
                <MailIcon className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0 flex-1 basis-56">
                <p className="text-sm font-medium text-zinc-950">
                  {s.failedEmails} email{s.failedEmails === 1 ? '' : 's'} could not be sent
                </p>
                <p className="text-[13px] text-zinc-500">
                  Every retry failed. Check the email provider settings.
                </p>
              </div>
            </div>
          )}
          {s.deadWebhookCount > 0 && (
            <div className="py-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-[#ff4d00]">
                  <ShieldIcon className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium text-zinc-950">
                    {s.deadWebhookCount} webhook failure{s.deadWebhookCount === 1 ? '' : 's'}
                  </p>
                  <p className="text-[13px] text-zinc-500">
                    These Stripe events failed processing and are quarantined. Automatic recovery
                    keeps retrying them; owner and admin staff can also replay one now.
                  </p>
                </div>
              </div>
              {replayError && (
                <p role="alert" className="mt-2 pl-[52px] text-[13px] text-red-700">
                  {replayError}
                </p>
              )}
              <ul className="mt-3 space-y-2 pl-[52px]">
                {s.deadWebhooks.map((w) => (
                  <li key={w.event_id} className="flex flex-wrap items-center gap-3 text-[13px]">
                    <span className="font-medium text-zinc-950">{w.type}</span>
                    <span className="text-zinc-500">
                      {w.attempts} attempts · {w.received_at}
                    </span>
                    {s.canReplay && (
                      <button
                        type="button"
                        disabled={replaying === w.event_id}
                        onClick={() => void replay(w.event_id)}
                        className="inline-flex h-7 items-center rounded-full bg-zinc-950 px-3 text-xs font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-40"
                      >
                        {replaying === w.event_id ? 'Replaying…' : 'Replay'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {s.catalogFailures.count > 0 && (
            <div className="py-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-[#ff4d00]">
                  <FileIcon className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium text-zinc-950">
                    {s.catalogFailures.count} publishing failure
                    {s.catalogFailures.count === 1 ? '' : 's'}
                  </p>
                  <p className="text-[13px] text-zinc-500">
                    These changes are saved but not yet live on the storefront. Publishing retries
                    automatically, waiting longer after each failure.
                  </p>
                </div>
              </div>
              <ul className="mt-3 space-y-2 pl-[52px]">
                {s.catalogFailures.items.map((w) => (
                  <li
                    key={`${w.entity_type}:${w.entity_id}`}
                    className="flex flex-wrap items-center gap-3 text-[13px]"
                  >
                    <span className="font-medium text-zinc-950">
                      {w.entity_type} {w.entity_id}
                    </span>
                    <span className="text-zinc-500">
                      {w.last_error} · {w.retry_count} attempts
                      {w.next_attempt_at ? ` · next ${w.next_attempt_at}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      <section aria-labelledby="sales-overview" className="mt-12">
        <h2 id="sales-overview" className="text-[15px] font-medium text-zinc-950">
          Sales overview
        </h2>
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-7 xl:grid-cols-4">
          {revenueRows.map((row) => (
            <div key={row.currency} className="border-t border-zinc-200 pt-3">
              <dt className="text-[13px] font-medium text-zinc-500">
                Gross sales ({row.currency})
              </dt>
              <dd className="mt-1.5 text-[26px] leading-none font-medium tracking-tight text-zinc-950">
                {formatMoney(row.revenue, row.currency)}
              </dd>
              <dd className="mt-1.5 text-[13px] text-zinc-500">
                Original amounts, including refunded sales
              </dd>
            </div>
          ))}
          <div className="border-t border-zinc-200 pt-3">
            <dt className="text-[13px] font-medium text-zinc-500">Orders</dt>
            <dd className="mt-1.5 text-[26px] leading-none font-medium tracking-tight text-zinc-950">
              {s.paidOrders}
            </dd>
            <dd className="mt-1.5 text-[13px] text-zinc-500">{s.pendingOrders} awaiting payment</dd>
          </div>
          <div className="border-t border-zinc-200 pt-3">
            <dt className="text-[13px] font-medium text-zinc-500">Active products</dt>
            <dd className="mt-1.5 text-[26px] leading-none font-medium tracking-tight text-zinc-950">
              {s.activeProducts}
            </dd>
            <dd className="mt-1.5 text-[13px] text-zinc-500">{s.lowStockSkus} SKUs low on stock</dd>
          </div>
        </dl>

        <div className="mt-8 rounded-2xl bg-zinc-50 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-zinc-950">Sales, last {s.periodDays} days</h3>
            <nav
              aria-label="Sales period"
              className="flex rounded-full bg-white p-1 text-[13px] font-medium"
            >
              {([7, 30, 90] as const).map((d) => (
                <Link
                  key={d}
                  to="/admin"
                  search={{ days: d }}
                  aria-current={d === s.periodDays ? 'true' : undefined}
                  className={
                    d === s.periodDays
                      ? 'rounded-full bg-zinc-950 px-3.5 py-1.5 text-white'
                      : 'rounded-full px-3.5 py-1.5 text-zinc-500 transition-colors hover:text-zinc-950'
                  }
                >
                  {d} days
                </Link>
              ))}
            </nav>
          </div>
          {s.periodStats.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500" role="status">
              No paid sales in this period yet.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-zinc-950/[0.06]">
              {s.periodStats.map((row) => (
                <li key={row.currency} className="py-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-medium text-zinc-950">{row.currency}</p>
                    <p className="text-sm text-zinc-500">
                      Net{' '}
                      <span className="font-medium text-zinc-950">
                        {formatMoney(row.netCents, row.currency)}
                      </span>
                    </p>
                  </div>
                  <div
                    className="mt-3 h-1 overflow-hidden rounded-full bg-zinc-950/10"
                    role="img"
                    aria-label={`Net sales are ${row.grossCents > 0 ? Math.max(0, Math.min(100, Math.round((row.netCents / row.grossCents) * 100))) : 0} percent of gross sales in ${row.currency}; the rest is refunds`}
                  >
                    <div
                      className="h-full rounded-full bg-zinc-950"
                      style={{
                        width: `${row.grossCents > 0 ? Math.max(0, Math.min(100, (row.netCents / row.grossCents) * 100)) : 0}%`,
                      }}
                    />
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
                    <div>
                      <dt className="text-[13px] font-medium text-zinc-500">Gross sales</dt>
                      <dd className="mt-1 text-base font-medium text-zinc-950">
                        {formatMoney(row.grossCents, row.currency)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[13px] font-medium text-zinc-500">Refunds</dt>
                      <dd className="mt-1 text-base font-medium text-zinc-950">
                        {formatMoney(row.refundCents, row.currency)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[13px] font-medium text-zinc-500">Net sales</dt>
                      <dd className="mt-1 text-base font-medium text-zinc-950">
                        {formatMoney(row.netCents, row.currency)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[13px] font-medium text-zinc-500">Paid orders</dt>
                      <dd className="mt-1 text-base font-medium text-zinc-950">{row.paidOrders}</dd>
                    </div>
                    <div>
                      <dt className="text-[13px] font-medium text-zinc-500">Average order</dt>
                      <dd className="mt-1 text-base font-medium text-zinc-950">
                        {formatMoney(row.aovCents, row.currency)}
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs leading-relaxed text-zinc-500">
            Period boundaries are UTC. Gross sales count paid orders by order date. Refunds count
            settled refunds by refund date, so a refund can appear in a later period than its order.
            Currencies are never combined.
          </p>
        </div>
      </section>

      <section aria-labelledby="recent-orders" className="mt-12">
        <div className="flex items-center justify-between gap-3">
          <h2 id="recent-orders" className="text-[15px] font-medium text-zinc-950">
            Recent orders
          </h2>
          <Link
            to="/admin/orders"
            search={{ q: '', mode: 'number', view: 'queue', payment: 'all', from: '', to: '' }}
            className={`${pillWhite} group`}
          >
            View all
            <ArrowRightIcon className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
        <div className="mt-2">
          <AdminDataTableShell>
            <Table>
              <TableCaption className="sr-only">Recent orders</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Order</TableHead>
                  <TableHead scope="col">Customer</TableHead>
                  <TableHead scope="col">Payment</TableHead>
                  <TableHead scope="col" className="text-right">
                    Total
                  </TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">Open order</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.recent.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center">
                      No orders yet. When customers check out, orders will appear here.
                    </TableCell>
                  </TableRow>
                ) : null}
                {s.recent.map((o) => (
                  <TableRow key={o.id} className="group">
                    <TableCell className="font-medium">
                      <Link
                        to="/admin/orders/$id"
                        params={{ id: o.id }}
                        className="hover:underline"
                      >
                        {o.number}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-normal text-zinc-500">
                      {o.customer_email}
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={o.payment_status} />
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatMoney(o.total_cents, o.currency)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={o.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      <ArrowRightIcon className="ml-auto h-4 w-4 text-zinc-300 transition-all group-hover:translate-x-0.5 group-hover:text-zinc-950" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </AdminDataTableShell>
        </div>
      </section>

      <section aria-labelledby="shortcuts" className="mt-12">
        <h2 id="shortcuts" className="text-[15px] font-medium text-zinc-950">
          Shortcuts
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Link
            to="/admin/orders"
            search={{ q: '', mode: 'number', view: 'queue', payment: 'all', from: '', to: '' }}
            className={tileCls}
          >
            <span className="flex items-start justify-between">
              <OrdersIcon className="h-5 w-5 text-zinc-950" />
              <ArrowRightIcon className="h-4 w-4 text-zinc-300 transition-all group-hover:translate-x-0.5 group-hover:text-zinc-950" />
            </span>
            <span className="mt-4 block text-sm font-medium text-zinc-950">Fulfillment queue</span>
            <span className="mt-1 block text-[13px] leading-relaxed text-zinc-500">
              Orders paid and waiting to ship.
            </span>
          </Link>
          <Link
            to="/admin/orders"
            search={{ q: '', mode: 'number', view: 'returns', payment: 'all', from: '', to: '' }}
            className={tileCls}
          >
            <span className="flex items-start justify-between">
              <ReturnIcon className="h-5 w-5 text-zinc-950" />
              <ArrowRightIcon className="h-4 w-4 text-zinc-300 transition-all group-hover:translate-x-0.5 group-hover:text-zinc-950" />
            </span>
            <span className="mt-4 block text-sm font-medium text-zinc-950">Returns to review</span>
            <span className="mt-1 block text-[13px] leading-relaxed text-zinc-500">
              Review requested returns and refunds.
            </span>
          </Link>
          <Link
            to="/admin/orders"
            search={{
              q: '',
              mode: 'number',
              view: 'payment-issues',
              payment: 'all',
              from: '',
              to: '',
            }}
            className={tileCls}
          >
            <span className="flex items-start justify-between">
              <ShieldIcon className="h-5 w-5 text-zinc-950" />
              <ArrowRightIcon className="h-4 w-4 text-zinc-300 transition-all group-hover:translate-x-0.5 group-hover:text-zinc-950" />
            </span>
            <span className="mt-4 block text-sm font-medium text-zinc-950">Payment issues</span>
            <span className="mt-1 block text-[13px] leading-relaxed text-zinc-500">
              Orders whose payment needs attention.
            </span>
          </Link>
          <Link
            to="/admin/inventory"
            search={{ q: '', page: 1, low: false, sku: undefined, size: undefined }}
            className={tileCls}
          >
            <span className="flex items-start justify-between">
              <BoxIcon className="h-5 w-5 text-zinc-950" />
              <ArrowRightIcon className="h-4 w-4 text-zinc-300 transition-all group-hover:translate-x-0.5 group-hover:text-zinc-950" />
            </span>
            <span className="mt-4 block text-sm font-medium text-zinc-950">Inventory</span>
            <span className="mt-1 block text-[13px] leading-relaxed text-zinc-500">
              Check stock levels and low SKUs.
            </span>
          </Link>
        </div>
      </section>
    </main>
  );
}

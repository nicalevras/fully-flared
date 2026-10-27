import { useState } from 'react';
import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router';
import { useAdminAction } from '../../components/AdminNav';
import { staffMiddleware } from '../../server/staff-middleware';
import { requireStaffPermission } from '../../server/session';
import { useStoreCurrency } from '../../lib/use-store-currency';
import { createServerFn } from '@tanstack/react-start';
import { getSettings } from '../../server/settings';
import { paidRevenueByCurrency, type CurrencyRevenue } from '../../server/reports';
import { failingCatalogWork, type FailingCatalogWork } from '../../server/catalog-operations';
import { ArrowRightIcon } from '../../components/icons';
import { formatMoney } from '../../components/ProductCard';
import { StatusBadge } from '../../components/StatusBadge';
import type { OrderStatus, PaymentStatus } from '../../db/schema';
import { btnPrimary, cardCls, pageSub, pageTitle, tableCls, tableWrap } from '../../components/ui';
import { roleCan, roles, type StaffRole } from '../../lib/permissions';

type Stats = {
  storeName: string;
  revenues: CurrencyRevenue[];
  paidOrders: number;
  pendingOrders: number;
  activeProducts: number;
  lowStockSkus: number;
  returnsPending: number;
  deadWebhooks: Array<{ event_id: string; type: string; attempts: number; received_at: string }>;
  deadWebhookCount: number;
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
  .handler(async ({ context }): Promise<Stats> => {
    requireStaffPermission(context.staff, 'report', 'view');
    const { env } = await import('cloudflare:workers');
    const db = env.DB;
    const role = roles[context.staff.role as StaffRole];
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
    ]);
    return {
      storeName: settings.storeName,
      revenues: revenue,
      paidOrders: revenue.reduce((sum, row) => sum + row.orders, 0),
      pendingOrders: pending?.n ?? 0,
      activeProducts: products?.n ?? 0,
      lowStockSkus: low?.n ?? 0,
      returnsPending: returns?.n ?? 0,
      recent: recent.results,
      deadWebhooks: deadWebhooks.results,
      deadWebhookCount: deadCount?.n ?? 0,
      canReplay: role?.authorize({ webhook: ['replay'] }).success ?? false,
      catalogFailures,
    };
  });

export const Route = createFileRoute('/admin/')({
  beforeLoad: ({ context }) => {
    if (!roleCan(context.staff?.role, 'report', 'view'))
      throw redirect({
        to: '/admin/orders',
        search: { q: '', view: 'queue', payment: 'all', from: '', to: '' },
      });
  },
  loader: async () => getData(),
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
  const cards: Array<[string, string, string]> = [
    ...(s.revenues.length ? s.revenues : [{ currency, revenue: 0, orders: 0 }]).map(
      (row): [string, string, string] => [
        `Gross sales (${row.currency})`,
        formatMoney(row.revenue, row.currency),
        'Original amounts, including refunded sales',
      ]
    ),
    ['Orders', String(s.paidOrders), `${s.pendingOrders} awaiting payment`],
    ['Active products', String(s.activeProducts), `${s.lowStockSkus} SKUs low on stock`],
    [
      'Returns to review',
      String(s.returnsPending),
      'Requested, plus failed refunds needing attention',
    ],
    ...(s.deadWebhookCount
      ? ([
          ['Webhook failures', String(s.deadWebhookCount), 'Dead-lettered events awaiting replay'],
        ] as Array<[string, string, string]>)
      : []),
    ...(s.catalogFailures.count
      ? [
          [
            'Publishing failures',
            String(s.catalogFailures.count),
            'Storefront changes that keep failing to publish',
          ] satisfies [string, string, string],
        ]
      : []),
  ];
  return (
    <main>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className={pageTitle}>Home</h1>
          <p className={pageSub}>Here is what is happening in {s.storeName} today.</p>
        </div>
        <Link to="/admin/products" className={btnPrimary}>
          Add product
        </Link>
      </div>

      <dl className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(([label, value, sub]) => (
          <div key={label} className={`${cardCls} p-5`}>
            <dt className="text-[13px] font-medium text-zinc-500">{label}</dt>
            <dd className="mt-1.5 text-2xl font-medium tracking-tight text-zinc-950">{value}</dd>
            <dd className="mt-0.5 text-[13px] text-zinc-500">{sub}</dd>
          </div>
        ))}
      </dl>

      {s.deadWebhooks.length > 0 && (
        <section className={`${cardCls} mt-5 p-5`}>
          <h2 className="text-sm font-medium text-zinc-950">Webhook failures needing attention</h2>
          <p className="mt-1 text-[13px] text-zinc-500">
            These Stripe events failed processing and are quarantined. Automatic recovery keeps
            retrying them; owner and admin staff can also replay one now.
          </p>
          {replayError && (
            <p role="alert" className="mt-2 text-[13px] text-red-700">
              {replayError}
            </p>
          )}
          <ul className="mt-3 space-y-2">
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
                    className="font-medium text-zinc-950 hover:underline disabled:opacity-50"
                  >
                    {replaying === w.event_id ? 'Replaying…' : 'Replay'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {s.catalogFailures.items.length > 0 && (
        <section className={`${cardCls} mt-5 p-5`}>
          <h2 className="text-sm font-medium text-zinc-950">Publishing failures</h2>
          <p className="mt-1 text-[13px] text-zinc-500">
            These changes are saved but not yet live on the storefront. Publishing retries
            automatically, waiting longer after each failure.
          </p>
          <ul className="mt-3 space-y-2">
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
        </section>
      )}

      <section className={`${cardCls} mt-5 overflow-hidden`}>
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <h2 className="text-sm font-medium text-zinc-950">Recent orders</h2>
          <Link
            to="/admin/orders"
            search={{ q: '', view: 'queue', payment: 'all', from: '', to: '' }}
            className="inline-flex items-center gap-1 text-[13px] font-medium text-zinc-950 hover:underline"
          >
            View all <ArrowRightIcon className="h-4 w-4" />
          </Link>
        </div>
        {s.recent.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-zinc-500" role="status">
            No orders yet. When customers check out, orders will appear here.
          </p>
        ) : (
          <div className={tableWrap}>
            <table className={tableCls}>
              <caption className="sr-only">Recent orders</caption>
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Status</th>
                  <th scope="col">Payment</th>
                  <th scope="col" className="text-right">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.recent.map((o) => (
                  <tr key={o.id}>
                    <td className="font-medium">
                      <Link
                        to="/admin/orders/$id"
                        params={{ id: o.id }}
                        className="hover:underline"
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
                    <td className="text-right font-medium">
                      {formatMoney(o.total_cents, o.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {s.lowStockSkus > 0 ? (
        <section className={`${cardCls} mt-5 flex flex-wrap items-center gap-3 p-5`}>
          <p className="text-sm text-zinc-950">
            <strong>
              {s.lowStockSkus} SKU{s.lowStockSkus === 1 ? ' is' : 's are'} running low
            </strong>{' '}
            <span className="text-zinc-500">
              (5 or fewer available). Restock before they sell out.
            </span>
          </p>
          <Link
            to="/admin/products"
            className="ml-auto text-[13px] font-medium text-zinc-950 hover:underline"
          >
            Review inventory
          </Link>
        </section>
      ) : null}
    </main>
  );
}

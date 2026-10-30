import { staffMiddleware } from '../../../server/staff-middleware';
import { requireStaffPermission } from '../../../server/session';
import { Link, createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { validateServerInput } from '../../../server/function-boundary';
import { idString } from '../../../schemas/common';
import { getCustomerWorkspace } from '../../../server/admin-customer-workspace';
import { formatMoney } from '../../../components/ProductCard';
import { formatAddress, formatDate } from '../../../lib/format';
import { StatusBadge } from '../../../components/StatusBadge';
import { btnSecondary, cardCls, pageSub, pageTitle } from '../../../components/ui';

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(idString))
  .handler(async ({ data: userId, context }) => {
    requireStaffPermission(context.staff, 'user', 'list');
    const { env } = await import('cloudflare:workers');
    return getCustomerWorkspace(env.DB, userId);
  });

export const Route = createFileRoute('/admin/customers_/$id')({
  loader: async ({ params }) => getData({ data: params.id }),
  component: CustomerWorkspacePage,
});

function CustomerWorkspacePage() {
  const ws = Route.useLoaderData();
  if (!ws.profile) {
    return (
      <main>
        <h1 className={pageTitle}>Customer not found</h1>
        <p className={pageSub}>This account does not exist.</p>
        <Link
          to="/admin/customers"
          search={{ page: 1, q: '', email: '' }}
          className={`${btnSecondary} mt-5`}
        >
          Back to customers
        </Link>
      </main>
    );
  }
  const addressLines = formatAddress(ws.latestAddress?.address_json ?? null);
  return (
    <main>
      <Link
        to="/admin/customers"
        search={{ page: 1, q: '', email: '' }}
        className="text-[13px] font-medium text-zinc-500 hover:text-zinc-950"
      >
        Customers
      </Link>
      <h1 className={`${pageTitle} mt-2`}>{ws.profile.name || ws.profile.email}</h1>
      <p className={pageSub}>
        {ws.profile.email} ·{' '}
        {ws.profile.role === 'customer'
          ? 'Customer account'
          : `Staff account (${ws.profile.role}), managed in the Staff section`}{' '}
        · joined {formatDate(ws.profile.created_at)}
      </p>

      <section className={`${cardCls} mt-5 p-5`} aria-label="Spending by currency">
        <h2 className="text-sm font-medium text-zinc-950">Spending, kept separate by currency</h2>
        {ws.totals.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No paid orders yet.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm text-zinc-600">
            {ws.totals.map((t) => (
              <li key={t.currency}>
                {t.currency} {formatMoney(t.spent_cents, t.currency)} across {t.orders} paid order
                {t.orders === 1 ? '' : 's'} (gross, including refunded sales)
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[13px] text-zinc-500">
          Amounts in different currencies are never added together.
        </p>
      </section>

      <section className={`${cardCls} mt-5 p-5`} aria-label="Contact and address">
        <h2 className="text-sm font-medium text-zinc-950">Contact and latest address</h2>
        <p className="mt-2 text-sm text-zinc-600">{ws.profile.email}</p>
        {addressLines.length > 0 ? (
          <address className="mt-2 text-sm leading-6 text-zinc-600 not-italic">
            {ws.latestAddress?.name ? <span className="block">{ws.latestAddress.name}</span> : null}
            {addressLines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </address>
        ) : (
          <p className="mt-2 text-sm text-zinc-500">No shipping address on record.</p>
        )}
      </section>

      <section className={`${cardCls} mt-5 overflow-hidden`} aria-label="Order history">
        <h2 className="px-5 pt-4 pb-3 text-sm font-medium text-zinc-950">Order history</h2>
        {ws.orders.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-zinc-500" role="status">
            No orders for this account.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {ws.orders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <Link
                  to="/admin/orders/$id"
                  params={{ id: o.id }}
                  className="font-medium text-zinc-950 hover:underline"
                >
                  {o.number}
                </Link>
                <StatusBadge value={o.status} />
                <span className="text-zinc-500">{formatDate(o.created_at)}</span>
                <span className="ml-auto font-medium">
                  {o.currency} {formatMoney(o.total_cents, o.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={`${cardCls} mt-5 overflow-hidden`} aria-label="Return history">
        <h2 className="px-5 pt-4 pb-3 text-sm font-medium text-zinc-950">Return history</h2>
        {ws.returns.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-zinc-500" role="status">
            No returns for this account.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {ws.returns.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <Link
                  to="/admin/orders/$id"
                  params={{ id: r.order_id }}
                  className="font-medium text-zinc-950 hover:underline"
                >
                  {r.number}
                </Link>
                <StatusBadge value={r.status} />
                <span className="text-zinc-500">{r.reason || 'No reason given'}</span>
                <span className="ml-auto text-zinc-500">{formatDate(r.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="mt-4 text-[13px] text-zinc-500">
        This workspace shows account orders only. Guest purchases made with the same email stay in
        the guest history from the contact lookup and are never merged in.
      </p>
    </main>
  );
}

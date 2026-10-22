import { useState } from 'react';
import { staffMiddleware } from '../../server/staff-middleware';
import { requireStaffPermission } from '../../server/session';
import { adminCustomers } from '../../server/admin-lists';
import { pageInputSchema } from '../../schemas/pagination';
import { validateServerInput } from '../../server/function-boundary';
import { AdminPager } from '../../components/AdminPager';
import { formatDate } from '../../lib/format';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useAdminAction } from '../../components/AdminNav';
import { formatMoney } from '../../components/ProductCard';
import {
  Badge,
  cardCls,
  inputCls,
  pageSub,
  pageTitle,
  tableCls,
  tableWrap,
} from '../../components/ui';

const ROLES = ['customer', 'support', 'warehouse', 'manager', 'owner'];

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(pageInputSchema))
  .handler(async ({ data, context }) => {
    const { env } = await import('cloudflare:workers');
    const me = context.staff;
    requireStaffPermission(me, 'user', 'list');
    return { ...(await adminCustomers(env.DB, data)), myRole: me.role, myId: me.id };
  });

export const Route = createFileRoute('/admin/customers')({
  validateSearch: pageInputSchema,
  loaderDeps: ({ search }) => ({ page: search.page }),
  loader: async ({ deps }) => getData({ data: deps }),
  component: AdminCustomers,
});

function AdminCustomers() {
  const adminAction = useAdminAction();

  const { customers, total, myRole, page } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [msg, setMsg] = useState('');
  const [busyId, setBusyId] = useState('');
  const canManageRoles = myRole === 'owner' || myRole === 'admin';

  return (
    <main>
      <h1 className={pageTitle}>Customers</h1>
      <p className={pageSub}>
        {total} account{total === 1 ? '' : 's'}
        {total > customers.length ? `, showing ${customers.length} on this page` : ''}. Everyone who
        signs up appears here with their order history. Staff roles control what someone can do in
        this admin.
      </p>

      <AdminPager
        label="Customers pagination"
        page={page}
        total={total}
        pageSize={200}
        onPage={(page) => {
          void navigate({ search: (prev) => ({ ...prev, page }) });
        }}
      />
      <section className={`${cardCls} mt-6 overflow-hidden`}>
        {customers.length === 0 ? (
          <p className="p-5 text-sm text-zinc-500" role="status">
            No accounts yet.
          </p>
        ) : (
          <div className={tableWrap}>
            <table className={tableCls}>
              <caption className="sr-only">Customers and staff</caption>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Role</th>
                  <th scope="col">Orders</th>
                  <th scope="col">Data</th>
                  <th scope="col">Gross spending (includes refunds)</th>
                  <th scope="col">Last order</th>
                  <th scope="col">Joined</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className="flex items-center gap-3">
                        <span
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[13px] font-medium text-zinc-600"
                          aria-hidden
                        >
                          {(c.name || c.email).slice(0, 1).toUpperCase()}
                        </span>
                        <span>
                          <span className="block font-medium text-zinc-950">{c.name || '—'}</span>
                          <span className="block text-[13px] text-zinc-500">{c.email}</span>
                        </span>
                      </span>
                    </td>
                    <td>
                      {canManageRoles ? (
                        <span className="flex items-center gap-2">
                          <label className="sr-only" htmlFor={`role-${c.id}`}>
                            Role for {c.email}
                          </label>
                          <select
                            id={`role-${c.id}`}
                            className={`${inputCls} h-9 w-36`}
                            defaultValue={c.role}
                            disabled={busyId === c.id}
                            onChange={async (e) => {
                              const role = e.target.value;
                              setBusyId(c.id);
                              const r = await adminAction('user.setRole', { userId: c.id, role });
                              setBusyId('');
                              if (r.ok) {
                                setMsg(`${c.email} is now ${role}.`);
                                router.invalidate();
                              } else {
                                setMsg(r.error ?? 'Failed');
                                e.target.value = c.role;
                              }
                            }}
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </span>
                      ) : (
                        <Badge tone={c.role === 'customer' ? 'gray' : 'green'}>{c.role}</Badge>
                      )}
                    </td>
                    <td>{c.orders}</td>
                    <td>
                      <span className="flex items-center gap-2">
                        <button
                          className="text-[13px] font-medium text-zinc-950 underline-offset-2 hover:underline"
                          disabled={busyId === c.id}
                          onClick={async () => {
                            setBusyId(c.id);
                            const r = await adminAction('customer.export', { userId: c.id });
                            setBusyId('');
                            if (r.ok) {
                              const blob = new Blob([JSON.stringify(r.data, null, 2)], {
                                type: 'application/json',
                              });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `customer-${c.id}.json`;
                              a.click();
                              URL.revokeObjectURL(url);
                              setMsg(`Exported ${c.email}.`);
                            } else setMsg(r.error ?? 'Export failed');
                          }}
                        >
                          Export
                        </button>
                        <button
                          className="text-[13px] font-medium text-red-600 underline-offset-2 hover:underline"
                          disabled={busyId === c.id}
                          onClick={async () => {
                            if (
                              !window.confirm(
                                `Delete ${c.email} and anonymize their order history?`
                              )
                            )
                              return;
                            setBusyId(c.id);
                            const r = await adminAction('customer.delete', { userId: c.id });
                            setBusyId('');
                            if (r.ok) {
                              setMsg(`${c.email} deleted.`);
                              router.invalidate();
                            } else setMsg(r.error ?? 'Delete failed');
                          }}
                        >
                          Delete
                        </button>
                      </span>
                    </td>
                    <td className="font-medium">
                      {c.spending.length
                        ? c.spending.map((amount) => (
                            <span key={amount.currency} className="block">
                              {amount.currency} {formatMoney(amount.spent_cents, amount.currency)}
                            </span>
                          ))
                        : '—'}
                    </td>
                    <td className="text-zinc-500">
                      {c.last_order_at ? formatDate(c.last_order_at) : 'Never'}
                    </td>
                    <td className="text-zinc-500">{formatDate(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {!canManageRoles ? (
        <p className="mt-4 text-[13px] text-zinc-500">
          Only the store owner can change roles. Roles: customer (storefront only), support (orders
          and returns), warehouse (stock and shipping), manager (catalog and content), owner
          (everything).
        </p>
      ) : null}
      {msg ? (
        <p className="mt-4 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700" role="status">
          {msg}
        </p>
      ) : null}
    </main>
  );
}

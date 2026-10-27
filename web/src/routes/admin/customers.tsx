import { useState } from 'react';
import { staffMiddleware } from '../../server/staff-middleware';
import { requireStaffPermission } from '../../server/session';
import { adminCustomers } from '../../server/admin-lists';
import { pageInputSchema } from '../../schemas/pagination';
import * as z from 'zod';
import { contactHistory, lookupContact } from '../../server/admin-contacts';
import { btnPrimary, labelCls } from '../../components/ui';
import { validateServerInput } from '../../server/function-boundary';
import { AdminPager } from '../../components/AdminPager';
import { formatDate } from '../../lib/format';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
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

const customersInput = pageInputSchema.extend({
  q: z.string().max(320).default(''),
  email: z.string().max(320).default(''),
});

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(customersInput))
  .handler(async ({ data, context }) => {
    const { env } = await import('cloudflare:workers');
    const me = context.staff;
    requireStaffPermission(me, 'user', 'list');
    const lookup = data.q ? await lookupContact(env.DB, data.q) : null;
    const history = data.email ? await contactHistory(env.DB, data.email) : null;
    return {
      ...(await adminCustomers(env.DB, data)),
      lookup,
      history,
      myRole: me.role,
      myId: me.id,
    };
  });

export const Route = createFileRoute('/admin/customers')({
  validateSearch: (search: Record<string, unknown>) => ({
    page:
      typeof search.page === 'number' && Number.isInteger(search.page) && search.page >= 1
        ? search.page
        : 1,
    q: typeof search.q === 'string' ? search.q.slice(0, 320) : '',
    email: typeof search.email === 'string' ? search.email.slice(0, 320) : '',
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getData({ data: deps }),
  component: AdminCustomers,
});

function AdminCustomers() {
  const adminAction = useAdminAction();

  const { customers, total, myRole, page, lookup, history } = Route.useLoaderData();
  const search = Route.useSearch();
  const [emailQuery, setEmailQuery] = useState(search.q);
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
        {total > customers.length ? `, showing ${customers.length} on this page` : ''}. Shoppers and
        staff are listed together here for now, and staff rows are marked by their role. Open a
        customer to see their workspace. Role changes affect admin access, never shopper history.
      </p>
      <section className={`${cardCls} mt-5 p-4`} aria-label="Staff accounts on this page">
        <h2 className="text-sm font-medium text-zinc-950">Staff on this page</h2>
        {customers.filter((c) => c.role !== 'customer').length === 0 ? (
          <p className="mt-1 text-sm text-zinc-500">No staff accounts on this page.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm text-zinc-600">
            {customers
              .filter((c) => c.role !== 'customer')
              .map((c) => (
                <li key={c.id}>
                  {c.email} · {c.role}. Staff access is managed with the role control in the table.
                  Shopper support never changes a role.
                </li>
              ))}
          </ul>
        )}
      </section>

      <form
        className={`${cardCls} mt-5 flex flex-wrap items-end gap-3 p-4`}
        onSubmit={(event) => {
          event.preventDefault();
          void navigate({ search: { page: 1, q: emailQuery.trim(), email: '' } });
        }}
      >
        <div className="min-w-56 flex-1">
          <label className={labelCls} htmlFor="customer-email">
            Find a contact by email
          </label>
          <input
            id="customer-email"
            className={inputCls}
            value={emailQuery}
            onChange={(event) => setEmailQuery(event.target.value)}
            placeholder="ada@example.com"
          />
        </div>
        <button type="submit" className={btnPrimary}>
          Look up
        </button>
      </form>
      <p className="mt-2 text-[13px] text-zinc-500">
        Guest purchases and account orders are separate records, even when the email matches. A
        lookup shows counts first. History loads only when you open the contact.
      </p>

      {search.q && lookup ? (
        <section className={`${cardCls} mt-4 p-4`} aria-label="Contact lookup result">
          <h2 className="text-sm font-medium text-zinc-950">{lookup.email}</h2>
          <ul className="mt-2 space-y-1 text-sm text-zinc-600">
            <li>
              Account:{' '}
              {lookup.account
                ? `${lookup.account.name || lookup.account.email} (${lookup.account.role}), ${lookup.accountOrderCount} account order${lookup.accountOrderCount === 1 ? '' : 's'}`
                : 'no account with this email'}
            </li>
            <li>
              Guest purchases (no account): {lookup.guestOrderCount} order
              {lookup.guestOrderCount === 1 ? '' : 's'}
            </li>
          </ul>
          <button
            type="button"
            className={btnPrimary}
            onClick={() => void navigate({ search: { page: 1, q: search.q, email: lookup.email } })}
          >
            Open contact history
          </button>
        </section>
      ) : search.q ? (
        <p className={`${cardCls} mt-4 p-4 text-sm text-zinc-500`} role="status">
          Enter an email address to look up a contact.
        </p>
      ) : null}

      {history ? (
        <section className={`${cardCls} mt-4 p-4`} aria-label="Contact history">
          <h2 className="text-sm font-medium text-zinc-950">History for {history.email}</h2>
          <h3 className="mt-3 text-[13px] font-medium text-zinc-950">Account orders</h3>
          {history.account.length === 0 ? (
            <p className="text-sm text-zinc-500">No account orders.</p>
          ) : (
            <ul className="text-sm text-zinc-600">
              {history.account.map((o) => (
                <li key={o.id}>
                  {o.number} · {o.status.replace(/_/g, ' ')} · {o.currency}{' '}
                  {formatMoney(o.total_cents, o.currency)} · {formatDate(o.created_at)}
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-3 text-[13px] font-medium text-zinc-950">
            Guest purchases (no account)
          </h3>
          {history.guest.length === 0 ? (
            <p className="text-sm text-zinc-500">No guest purchases.</p>
          ) : (
            <ul className="text-sm text-zinc-600">
              {history.guest.map((o) => (
                <li key={o.id}>
                  {o.number} · {o.status.replace(/_/g, ' ')} · {o.currency}{' '}
                  {formatMoney(o.total_cents, o.currency)} · {formatDate(o.created_at)}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[13px] text-zinc-500">
            Guest purchases are not owned by the account with the same email and are never merged
            into account history.
          </p>
        </section>
      ) : null}

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
                          <span className="block font-medium text-zinc-950">
                            <Link
                              to="/admin/customers/$id"
                              params={{ id: c.id }}
                              className="hover:underline"
                            >
                              {c.name || '—'}
                            </Link>
                          </span>
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

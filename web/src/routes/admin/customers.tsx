import { createContext, useContext, useState } from 'react';
import { staffMiddleware } from '../../server/staff-middleware';
import { requireStaffPermission } from '../../server/session';
import { adminCustomers } from '../../server/admin-lists';
import { pageInputSchema } from '../../schemas/pagination';
import * as z from 'zod';
import { contactHistory, lookupContact } from '../../server/admin-contacts';
import { btnPrimary, btnSmall } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { validateServerInput } from '../../server/function-boundary';
import type { CellContext, ColumnDef, OnChangeFn, PaginationState } from '@tanstack/react-table';
import { DataTable, DataTableSearch } from '../../components/ui/data-table';
import type { DataTableFeatures } from '../../components/data-table-features';
import { formatDate } from '../../lib/format';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useAdminAction } from '../../components/AdminNav';
import { formatMoney } from '../../components/ProductCard';
import { Badge, cardCls, inputCls, pageSub, pageTitle } from '../../components/ui';

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
  staleTime: 30_000,
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

type CustomerRow = Awaited<ReturnType<typeof getData>>['customers'][number];
type RoleControlState = {
  canManage: boolean;
  staged: Record<string, string>;
  busyId: string;
  stage: (customer: CustomerRow, role: string) => void;
  requestSave: (customer: CustomerRow, role: string) => void;
};
const RoleControls = createContext<RoleControlState | null>(null);

// A module-level cell keeps its identity across renders, so staging a role
// does not remount the select and the keyboard keeps its place.
function RoleCell({ row }: CellContext<DataTableFeatures, CustomerRow>) {
  const controls = useContext(RoleControls);
  const c = row.original;
  if (!controls?.canManage)
    return <Badge tone={c.role === 'customer' ? 'gray' : 'green'}>{c.role}</Badge>;
  const staged = controls.staged[c.id];
  const busy = controls.busyId === c.id;
  return (
    <span className="flex items-center gap-2">
      <label className="sr-only" htmlFor={`role-${c.id}`}>
        Role for {c.email}
      </label>
      <select
        id={`role-${c.id}`}
        className={`${inputCls} h-9 w-36`}
        value={staged ?? c.role}
        disabled={busy}
        onChange={(e) => controls.stage(c, e.target.value)}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {staged ? (
        <>
          <button
            type="button"
            className={btnSmall}
            aria-label={`Save role for ${c.email}`}
            disabled={busy}
            onClick={() => controls.requestSave(c, staged)}
          >
            Save
          </button>
          <button
            type="button"
            className={btnSmall}
            aria-label={`Discard role change for ${c.email}`}
            disabled={busy}
            onClick={() => controls.stage(c, c.role)}
          >
            Discard
          </button>
        </>
      ) : null}
    </span>
  );
}

function AdminCustomers() {
  const adminAction = useAdminAction();

  const { customers, total, myRole, page, lookup, history } = Route.useLoaderData();
  const search = Route.useSearch();
  const [deleteTarget, setDeleteTarget] = useState<(typeof customers)[number] | null>(null);
  const [guestBusy, setGuestBusy] = useState(false);
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [msg, setMsg] = useState('');
  const [busyId, setBusyId] = useState('');
  const canManageRoles = myRole === 'owner' || myRole === 'admin';
  const [stagedRoles, setStagedRoles] = useState<Record<string, string>>({});
  const [roleChange, setRoleChange] = useState<{ customer: CustomerRow; role: string } | null>(
    null
  );

  async function saveRole({ customer, role }: NonNullable<typeof roleChange>) {
    setBusyId(customer.id);
    const r = await adminAction('user.setRole', { userId: customer.id, role });
    setBusyId('');
    setStagedRoles(({ [customer.id]: _saved, ...rest }) => rest);
    if (r.ok) {
      setMsg(`${customer.email} is now ${role}.`);
      router.invalidate();
    } else setMsg(r.error ?? 'Failed');
  }

  const roleControls: RoleControlState = {
    canManage: canManageRoles,
    staged: stagedRoles,
    busyId,
    stage: (customer, role) =>
      setStagedRoles(({ [customer.id]: _previous, ...rest }) =>
        role === customer.role ? rest : { ...rest, [customer.id]: role }
      ),
    requestSave: (customer, role) => setRoleChange({ customer, role }),
  };

  const customerColumns: ColumnDef<DataTableFeatures, (typeof customers)[number]>[] = [
    {
      id: 'customer',
      header: 'Customer',
      enableHiding: false,
      cell: ({ row }) => {
        const c = row.original;
        return (
          <span className="flex items-center gap-3 whitespace-normal">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[13px] font-medium text-zinc-600"
              aria-hidden
            >
              {(c.name || c.email).slice(0, 1).toUpperCase()}
            </span>
            <span>
              <span className="block font-medium text-zinc-950">
                <Link to="/admin/customers/$id" params={{ id: c.id }} className="hover:underline">
                  {c.name || '—'}
                </Link>
              </span>
              <span className="block text-[13px] text-zinc-500">{c.email}</span>
            </span>
          </span>
        );
      },
    },
    {
      id: 'role',
      accessorKey: 'role',
      header: 'Role',
      cell: RoleCell,
    },
    {
      id: 'orders',
      accessorKey: 'orders',
      header: 'Orders',
      cell: ({ row }) => <span>{row.original.orders}</span>,
    },
    {
      id: 'data',
      accessorFn: (row) => row.email,
      header: 'Data',
      cell: ({ row }) => {
        const c = row.original;
        return (
          <span className="flex items-center gap-2">
            <button
              type="button"
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
              type="button"
              className="text-[13px] font-medium text-red-600 underline-offset-2 hover:underline"
              disabled={busyId === c.id}
              onClick={() => setDeleteTarget(c)}
            >
              Delete
            </button>
          </span>
        );
      },
    },
    {
      id: 'spending',
      accessorFn: (row) => row.spending,
      header: 'Gross spending (includes refunds)',
      cell: ({ row }) => {
        const c = row.original;
        return (
          <span className="font-medium">
            {c.spending.length
              ? c.spending.map((amount) => (
                  <span key={amount.currency} className="block">
                    {amount.currency} {formatMoney(amount.spent_cents, amount.currency)}
                  </span>
                ))
              : '—'}
          </span>
        );
      },
    },
    {
      id: 'last',
      accessorFn: (row) => row.last_order_at,
      header: 'Last order',
      cell: ({ row }) => (
        <span className="text-zinc-500">
          {row.original.last_order_at ? formatDate(row.original.last_order_at) : 'Never'}
        </span>
      ),
    },
    {
      id: 'joined',
      accessorFn: (row) => row.created_at,
      header: 'Joined',
      cell: ({ row }) => (
        <span className="text-zinc-500">{formatDate(row.original.created_at)}</span>
      ),
    },
  ];

  // Customers page at a fixed 200 rows from the loader; no page-size option.
  const handlePaginationChange: OnChangeFn<PaginationState> = (updater) => {
    const next =
      typeof updater === 'function' ? updater({ pageIndex: page - 1, pageSize: 200 }) : updater;
    void navigate({ search: (prev) => ({ ...prev, page: next.pageIndex + 1 }) });
  };

  return (
    <main>
      <h1 className={pageTitle}>Customers</h1>
      <p className={pageSub}>
        {total} account{total === 1 ? '' : 's'}. Shoppers and staff together, marked by role.
      </p>

      <p className="mt-2 text-[13px] text-zinc-500">
        Guest purchases and account orders are separate records, even when the email matches. Type
        an email above and the lookup runs as you type, showing counts first. History loads only
        when you open the contact.
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
          <div className="mt-4 border-t border-zinc-100 pt-4">
            <h3 className="text-[13px] font-medium text-zinc-950">
              Guest data for {history.email}
            </h3>
            {history.guest.length === 0 ? (
              <p className="text-sm text-zinc-500">No guest purchases to export.</p>
            ) : (
              <>
                <p className="mt-1 text-sm text-zinc-600">
                  Guest orders for this email: {history.guest.map((o) => o.number).join(', ')}.
                  Guest data erasure is withheld from this release, so these records can be exported
                  but not erased here. Account orders with the same email are never touched.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={btnPrimary}
                    disabled={guestBusy}
                    onClick={async () => {
                      setGuestBusy(true);
                      const r = await adminAction('guest.export', { email: history.email });
                      setGuestBusy(false);
                      if (r.ok) {
                        const blob = new Blob([JSON.stringify(r.data, null, 2)], {
                          type: 'application/json',
                        });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `guest-${history.email}.json`;
                        a.click();
                        URL.revokeObjectURL(url);
                        const truncated =
                          typeof r.data === 'object' &&
                          r.data !== null &&
                          'truncated' in r.data &&
                          r.data.truncated === true;
                        setMsg(
                          truncated
                            ? `Downloaded a partial export for ${history.email}. Some records were omitted because export limits were exceeded.`
                            : `Exported guest purchases for ${history.email}.`
                        );
                      } else setMsg(r.error ?? 'Guest export failed');
                    }}
                  >
                    Export guest purchases
                  </button>
                </div>
              </>
            )}
          </div>
        </section>
      ) : null}

      <section className="mt-6">
        <RoleControls.Provider value={roleControls}>
          <DataTable
            caption="Customers and staff"
            emptyMessage={search.q ? 'No accounts match this search.' : 'No accounts yet.'}
            columns={customerColumns}
            data={customers}
            pageIndex={page - 1}
            pageSize={200}
            rowCount={total}
            onPaginationChange={handlePaginationChange}
            toolbar={
              <DataTableSearch
                value={search.q}
                onSearch={(q) => void navigate({ search: { page: 1, q, email: '' } })}
                placeholder="ada@example.com"
                ariaLabel="Find a contact by email"
              />
            }
          />
        </RoleControls.Provider>
      </section>
      <section className={`${cardCls} mt-6 p-4`} aria-label="Staff accounts on this page">
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
      {!canManageRoles ? (
        <p className="mt-4 text-[13px] text-zinc-500">
          Only the store owner can change roles. Roles: customer (storefront only), support (orders
          and returns), warehouse (stock and shipping), manager (catalog and content), owner
          (everything).
        </p>
      ) : null}

      <ConfirmDialog
        request={
          roleChange
            ? roleChange.role === 'owner'
              ? {
                  title: 'Make this account an owner?',
                  body: `${roleChange.customer.email} will be able to change every setting and every role, including yours.`,
                  confirmLabel: 'Make owner',
                }
              : {
                  title: 'Change this role?',
                  body: `Change ${roleChange.customer.email} from ${roleChange.customer.role} to ${roleChange.role}?`,
                  confirmLabel: `Make ${roleChange.role}`,
                }
            : null
        }
        busy={!!busyId}
        onCancel={() => setRoleChange(null)}
        onConfirm={() => {
          const change = roleChange;
          setRoleChange(null);
          if (change) void saveRole(change);
        }}
      />
      <ConfirmDialog
        request={
          deleteTarget
            ? {
                title: 'Delete this account?',
                body: `Delete ${deleteTarget.email} and anonymize their order history? Guest purchases with the same email are not touched.`,
                confirmLabel: 'Delete account',
              }
            : null
        }
        busy={!!busyId}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          const c = deleteTarget;
          setDeleteTarget(null);
          if (!c) return;
          setBusyId(c.id);
          const r = await adminAction('customer.delete', { userId: c.id });
          setBusyId('');
          if (r.ok) {
            setMsg(`${c.email} deleted.`);
            router.invalidate();
          } else setMsg(r.error ?? 'Delete failed');
        }}
      />
      {msg ? (
        <p className="mt-4 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700" role="status">
          {msg}
        </p>
      ) : null}
    </main>
  );
}

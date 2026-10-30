import { useState } from 'react';
import { staffMiddleware } from '../../server/staff-middleware';
import { useStoreCurrency } from '../../lib/use-store-currency';
import { formatDate } from '../../lib/format';
import { pageWindow } from '../../lib/catalog-page';
import { AdminRowActions } from '../../components/AdminDataTable';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import * as z from 'zod';
import { validateServerInput } from '../../server/function-boundary';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { createServerFn } from '@tanstack/react-start';
import { useAdminAction, type AdminPayload } from '../../components/AdminNav';
import { StatusBadge } from '../../components/StatusBadge';
import type { DiscountStatus } from '../../db/schema';
import { formatMoney } from '../../components/ProductCard';
import { hintCls, labelCls, pageSub, pageTitle } from '../../components/ui';
import type { ColumnDef, OnChangeFn, PaginationState } from '@tanstack/react-table';
import { DataTable, DataTableSearch } from '../../components/ui/data-table';
import { ftsPhrase, ftsUsable } from '../../lib/fts-search';
import type { DataTableFeatures } from '../../components/data-table-features';
import { isPageSize, pageSizeOptions, pageSizeSchema } from '../../schemas/pagination';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../components/AdminActionFeedback';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { PlusIcon, XIcon } from 'lucide-react';

type DiscountRow = {
  id: string;
  code: string;
  type: string;
  value: number;
  status: DiscountStatus;
  usage_count: number;
  min_purchase_cents: number;
  usage_limit: number | null;
  expires_at: string | null;
};

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(
    validateServerInput(
      z.object({
        q: z.string().max(64).default(''),
        page: z.number().int().min(1).default(1),
        size: pageSizeSchema,
      })
    )
  )
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const q = data.q.trim().toUpperCase();
    // >= 3 chars: trigram FTS (substring, index-served). Shorter: prefix LIKE.
    const useFts = q ? ftsUsable(q) : false;
    const pattern = q && !useFts ? `${q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const where = useFts
      ? 'WHERE rowid IN (SELECT rowid FROM discounts_fts WHERE discounts_fts MATCH ?)'
      : pattern
        ? "WHERE code LIKE ? ESCAPE '\\'"
        : '';
    const searchBind = useFts ? ftsPhrase(q) : pattern;
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM discounts ${where}`)
      .bind(...(searchBind ? [searchBind] : []))
      .first<{ n: number }>();
    const total = count?.n ?? 0;
    const { page, offset } = pageWindow(total, data.page, data.size);
    const rows = await env.DB.prepare(
      `SELECT id, code, type, value, status, usage_count, min_purchase_cents, usage_limit, expires_at FROM discounts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
      .bind(...(searchBind ? [searchBind] : []), data.size, offset)
      .all<DiscountRow>();
    return { discounts: rows.results, total, page, pageSize: data.size };
  });

export const Route = createFileRoute('/admin/discounts')({
  staleTime: 30_000,
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q.slice(0, 64) : '',
    page:
      typeof search.page === 'number' && Number.isInteger(search.page) && search.page >= 1
        ? search.page
        : 1,
    size: isPageSize(search.size) ? search.size : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getData({ data: deps }),
  component: Page,
});

function describe(d: DiscountRow, currency: string) {
  return d.type === 'percentage' ? `${d.value}% off` : `${formatMoney(d.value, currency)} off`;
}

function Page() {
  const adminAction = useAdminAction();

  const currency = useStoreCurrency();
  const { discounts, total, page, pageSize } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [editingId, setEditingId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DiscountRow | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const router = useRouter();
  const emptyForm = {
    code: '',
    type: 'percentage',
    value: '10',
    minPurchase: '',
    usageLimit: '',
    expiresAt: '',
  };
  const [form, setForm] = useState(emptyForm);
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: string, payload: AdminPayload, ok: string): Promise<boolean> {
    setBusy(true);
    const r = await adminAction(action, payload);
    setBusy(false);
    if (r.ok) {
      setFeedback({ kind: 'status', message: ok });
      router.invalidate();
      return true;
    }
    setFeedback({ kind: 'error', message: r.error ?? 'Failed' });
    return false;
  }

  const formOf = (d: DiscountRow) => ({
    code: d.code,
    type: d.type,
    value: d.type === 'percentage' ? String(d.value) : (d.value / 100).toFixed(2),
    minPurchase: d.min_purchase_cents ? (d.min_purchase_cents / 100).toFixed(2) : '',
    usageLimit: d.usage_limit != null ? String(d.usage_limit) : '',
    expiresAt: d.expires_at ? d.expires_at.slice(0, 10) : '',
  });

  const parsedOf = (f: typeof form) => ({
    code: f.code,
    type: f.type,
    value: f.type === 'percentage' ? Number(f.value) : Math.round(Number(f.value) * 100),
    minPurchaseCents: f.minPurchase ? Math.round(Number(f.minPurchase) * 100) : 0,
    usageLimit: f.usageLimit ? Number(f.usageLimit) : null,
    expiresAt: f.expiresAt || null,
  });

  const editing = discounts.find((d) => d.id === editingId) ?? null;
  const dirty = editing
    ? JSON.stringify(parsedOf(form)) !==
      JSON.stringify({
        code: editing.code,
        type: editing.type,
        value: editing.value,
        minPurchaseCents: editing.min_purchase_cents,
        usageLimit: editing.usage_limit,
        expiresAt: editing.expires_at ? editing.expires_at.slice(0, 10) : null,
      })
    : false;

  const openCreate = () => {
    setEditingId('');
    setForm(emptyForm);
    setCreateOpen(true);
  };
  const openEdit = (d: DiscountRow) => {
    setCreateOpen(false);
    setForm(formOf(d));
    setEditingId(d.id);
  };

  const discountColumns: ColumnDef<DataTableFeatures, DiscountRow>[] = [
    {
      id: 'code',
      accessorKey: 'code',
      header: 'Code',
      cell: ({ row }) => (
        <span className="font-mono text-[13px] font-medium">{row.original.code}</span>
      ),
    },
    {
      id: 'discount',
      accessorFn: (row) => row.value,
      header: 'Discount',
      cell: ({ row }) => <span>{describe(row.original, currency)}</span>,
    },
    {
      id: 'conditions',
      accessorFn: (row) => row.min_purchase_cents,
      header: 'Conditions',
      cell: ({ row }) => {
        const d = row.original;
        return (
          <span className="text-zinc-500">
            {[
              d.min_purchase_cents > 0
                ? `Min ${formatMoney(d.min_purchase_cents, currency)}`
                : null,
              d.usage_limit != null ? `Limit ${d.usage_limit}` : null,
              d.expires_at ? `Expires ${formatDate(d.expires_at)}` : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'No conditions'}
          </span>
        );
      },
    },
    {
      id: 'used',
      accessorKey: 'usage_count',
      header: 'Used',
      cell: ({ row }) => <span className="text-zinc-500">{row.original.usage_count}×</span>,
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => <StatusBadge value={row.original.status} />,
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      enableHiding: false,
      cell: ({ row }) => {
        const d = row.original;
        return (
          <div className="flex justify-end">
            <AdminRowActions label={`Actions for ${d.code}`}>
              <DropdownMenuItem onSelect={() => openEdit(d)}>Edit</DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy}
                onSelect={() =>
                  void run(
                    'discount.toggle',
                    { discountId: d.id, active: d.status !== 'active' },
                    `${d.code} is now ${d.status !== 'active' ? 'active' : 'inactive'}.`
                  )
                }
              >
                {d.status === 'active' ? 'Deactivate' : 'Activate'}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy}
                variant="destructive"
                onSelect={() => setDeleteTarget(d)}
              >
                Delete
              </DropdownMenuItem>
            </AdminRowActions>
          </div>
        );
      },
    },
  ];

  const handlePaginationChange: OnChangeFn<PaginationState> = (updater) => {
    const current = { pageIndex: page - 1, pageSize };
    const next = typeof updater === 'function' ? updater(current) : updater;
    void navigate({
      search: {
        q: search.q,
        page: next.pageIndex + 1,
        size: isPageSize(next.pageSize) ? next.pageSize : pageSize,
      },
    });
  };

  async function submit() {
    const succeeded = await run(
      editingId ? 'discount.update' : 'discount.create',
      {
        ...(editingId ? { discountId: editingId } : {}),
        ...parsedOf(form),
      },
      editingId
        ? `Discount ${form.code.toUpperCase()} updated. Checkout validates the new terms on the next order.`
        : `Discount ${form.code.toUpperCase()} created.`
    );
    // FF-05: a failed update keeps the merchant in edit mode with
    // their input intact. Only success leaves editing.
    if (succeeded && editingId) setEditingId('');
    if (succeeded) {
      setCreateOpen(false);
      setForm(emptyForm);
    }
  }

  return (
    <main>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className={pageTitle}>Discounts</h1>
          <p className={pageSub}>Codes customers enter at checkout.</p>
        </div>
      </div>
      <AdminActionFeedback value={feedback} />

      {discounts.length === 0 && !search.q ? (
        <p className="mt-6 rounded-2xl bg-zinc-50 p-5 text-sm text-zinc-500" role="status">
          No discount codes yet. Use New to create your first one.
        </p>
      ) : (
        <div className="mt-6" tabIndex={0} role="region" aria-label="Discount codes">
          <DataTable
            caption="Discount codes"
            columns={discountColumns}
            data={discounts}
            pageIndex={page - 1}
            pageSize={pageSize}
            rowCount={total}
            pageSizeOptions={pageSizeOptions}
            onPaginationChange={handlePaginationChange}
            onRowClick={(row) => openEdit(row)}
            tableClassName="min-w-[640px]"
            emptyMessage={search.q ? `No codes match "${search.q}".` : 'No discount codes yet.'}
            toolbar={
              <DataTableSearch
                value={search.q}
                onSearch={(q) => void navigate({ search: { q, page: 1, size: search.size } })}
                placeholder="Search Promo Codes"
                ariaLabel="Find a code"
              />
            }
            toolbarEnd={
              <Button
                type="button"
                size="sm"
                onClick={openCreate}
                className="h-8 rounded-md bg-zinc-950 text-white shadow-none hover:bg-zinc-800"
              >
                <PlusIcon /> New
              </Button>
            }
          />
        </div>
      )}

      <Drawer
        instant
        swipeDirection="right"
        open={createOpen || editingId !== ''}
        onOpenChange={(open) => {
          if (open) return;
          if (editingId) {
            if (dirty) {
              setConfirmDiscard(true);
              return;
            }
            setEditingId('');
          } else {
            setCreateOpen(false);
          }
        }}
      >
        <DrawerContent
          className="w-full max-w-[calc(100vw-1rem)] gap-0 overflow-hidden p-0 sm:max-w-2xl"
          initialFocus={false}
        >
          <DrawerClose
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute top-3 right-3"
              >
                <XIcon />
                <span className="sr-only">Close</span>
              </Button>
            }
          />
          <DrawerHeader className="p-5 pr-14 pb-0 sm:p-6 sm:pr-14 sm:pb-0">
            <DrawerTitle>{editingId ? (editing?.code ?? form.code) : 'New discount'}</DrawerTitle>
            <DrawerDescription>
              {editingId
                ? editing
                  ? describe(editing, currency)
                  : ''
                : 'Create a code customers can enter at checkout.'}
            </DrawerDescription>
          </DrawerHeader>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              <div>
                <label className={labelCls} htmlFor="d-code">
                  Code
                </label>
                <Input
                  id="d-code"
                  placeholder="SUMMER10"
                  className="rounded-lg"
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelCls} htmlFor="d-kind">
                    Type
                  </label>
                  <Select
                    value={form.type}
                    onValueChange={(value) => setForm({ ...form, type: value })}
                  >
                    <SelectTrigger id="d-kind" className="w-full rounded-lg">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="percentage">Percentage off</SelectItem>
                      <SelectItem value="fixed_amount">Fixed amount off</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className={labelCls} htmlFor="d-value">
                    {form.type === 'percentage' ? 'Percent off' : 'Amount off ($)'}
                  </label>
                  <Input
                    id="d-value"
                    inputMode="decimal"
                    placeholder="10"
                    className="rounded-lg"
                    value={form.value}
                    onChange={(e) => setForm({ ...form, value: e.target.value })}
                  />
                  <p className={hintCls}>
                    {form.type === 'percentage' ? '10 means 10% off.' : '10.00 means $10.00 off.'}
                  </p>
                </div>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <div>
                  <label className={labelCls} htmlFor="d-min">
                    Minimum order ($)
                  </label>
                  <Input
                    id="d-min"
                    inputMode="decimal"
                    placeholder="No minimum"
                    className="rounded-lg"
                    value={form.minPurchase}
                    onChange={(e) => setForm({ ...form, minPurchase: e.target.value })}
                  />
                </div>
                <div>
                  <label className={labelCls} htmlFor="d-limit">
                    Total uses
                  </label>
                  <Input
                    id="d-limit"
                    inputMode="numeric"
                    placeholder="Unlimited"
                    className="rounded-lg"
                    value={form.usageLimit}
                    onChange={(e) => setForm({ ...form, usageLimit: e.target.value })}
                  />
                </div>
                <div>
                  <label className={labelCls} htmlFor="d-expires">
                    Expires
                  </label>
                  <Input
                    id="d-expires"
                    type="date"
                    className="rounded-lg"
                    value={form.expiresAt}
                    onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
                  />
                </div>
              </div>
            </div>
            {editingId ? (
              dirty ? (
                <div className="flex flex-wrap items-center justify-end gap-3 border-t border-zinc-100 bg-white px-5 py-3.5 sm:px-6">
                  <span className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (editing) setForm(formOf(editing));
                        setEditingId('');
                      }}
                    >
                      Discard
                    </Button>
                    <Button type="submit" size="sm" disabled={busy || !form.code}>
                      {busy ? 'Saving…' : 'Save changes'}
                    </Button>
                  </span>
                </div>
              ) : null
            ) : (
              <div className="flex items-center justify-end border-t border-zinc-100 bg-white px-5 py-3.5 sm:px-6">
                <Button type="submit" disabled={busy || !form.code}>
                  {busy ? 'Creating…' : 'Create'}
                </Button>
              </div>
            )}
          </form>
        </DrawerContent>
      </Drawer>

      <ConfirmDialog
        request={
          confirmDiscard
            ? {
                title: 'Discard unsaved changes?',
                body: "Your changes to this discount haven't been saved.",
                confirmLabel: 'Discard changes',
              }
            : null
        }
        busy={busy}
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          if (editing) setForm(formOf(editing));
          setEditingId('');
        }}
      />
      <ConfirmDialog
        request={
          deleteTarget
            ? {
                title: 'Delete this discount?',
                body: `Delete discount code ${deleteTarget.code}? Customers can no longer use it. Orders already placed keep their recorded totals.`,
                confirmLabel: 'Delete discount',
              }
            : null
        }
        busy={busy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          const d = deleteTarget;
          setDeleteTarget(null);
          if (d) await run('discount.delete', { discountId: d.id }, `${d.code} deleted.`);
        }}
      />
    </main>
  );
}

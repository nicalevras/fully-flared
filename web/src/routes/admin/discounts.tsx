import { useEffect, useState } from 'react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { createPortal } from 'react-dom';
import { staffMiddleware } from '../../server/staff-middleware';
import { useStoreCurrency } from '../../lib/use-store-currency';
import { formatDate } from '../../lib/format';
import { pageWindow } from '../../lib/catalog-page';
import { AdminPagination } from '../../components/AdminPagination';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import * as z from 'zod';
import { validateServerInput } from '../../server/function-boundary';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { createServerFn } from '@tanstack/react-start';
import { useAdminAction, type AdminPayload } from '../../components/AdminNav';
import { StatusBadge } from '../../components/StatusBadge';
import type { DiscountStatus } from '../../db/schema';
import { formatMoney } from '../../components/ProductCard';
import { hintCls, labelCls } from '../../components/ui';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../components/AdminActionFeedback';
import { SearchIcon } from '../../components/icons';
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { EllipsisIcon, PlusIcon, XIcon } from 'lucide-react';

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

const PAGE_SIZE = 25;

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(
    validateServerInput(
      z.object({
        q: z.string().max(64).default(''),
        page: z.number().int().min(1).default(1),
      })
    )
  )
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    const q = data.q.trim().toUpperCase();
    const pattern = q ? `${q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const count = await env.DB.prepare(
      pattern
        ? "SELECT COUNT(*) AS n FROM discounts WHERE code LIKE ? ESCAPE '\\'"
        : 'SELECT COUNT(*) AS n FROM discounts'
    )
      .bind(...(pattern ? [pattern] : []))
      .first<{ n: number }>();
    const total = count?.n ?? 0;
    const { page, offset } = pageWindow(total, data.page, PAGE_SIZE);
    const rows = await env.DB.prepare(
      pattern
        ? "SELECT id, code, type, value, status, usage_count, min_purchase_cents, usage_limit, expires_at FROM discounts WHERE code LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ? OFFSET ?"
        : 'SELECT id, code, type, value, status, usage_count, min_purchase_cents, usage_limit, expires_at FROM discounts ORDER BY created_at DESC LIMIT ? OFFSET ?'
    )
      .bind(...(pattern ? [pattern] : []), PAGE_SIZE, offset)
      .all<DiscountRow>();
    return { discounts: rows.results, total, page, pageSize: PAGE_SIZE };
  });

export const Route = createFileRoute('/admin/discounts')({
  staleTime: 30_000,
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q.slice(0, 64) : '',
    page:
      typeof search.page === 'number' && Number.isInteger(search.page) && search.page >= 1
        ? search.page
        : 1,
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
  const [codeQuery, setCodeQuery] = useState(search.q);
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
  const [rowMenu, setRowMenu] = useState<{ id: string; top: number; right: number } | null>(null);

  useEffect(() => {
    if (!rowMenu) return;
    const close = () => setRowMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [rowMenu]);

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
    if (succeeded) {
      setEditingId('');
      setCreateOpen(false);
      setForm(emptyForm);
    }
  }

  return (
    <main>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[28px] leading-tight font-medium tracking-tight text-zinc-950">
            Discounts
          </h1>
          <p className="mt-1 text-sm text-zinc-500">Codes customers enter at checkout.</p>
        </div>
        <Button type="button" onClick={openCreate}>
          <PlusIcon className="size-4" />
          New
        </Button>
      </div>
      <AdminActionFeedback value={feedback} />

      <form
        className="mt-6 max-w-xl"
        onSubmit={(event) => {
          event.preventDefault();
          void navigate({ search: { q: codeQuery.trim(), page: 1 } });
        }}
      >
        <label className="sr-only" htmlFor="discount-q">
          Find a code
        </label>
        <div className="flex items-center gap-1 rounded-full bg-zinc-50 p-1 transition-shadow focus-within:ring-2 focus-within:ring-zinc-950/70">
          <SearchIcon className="ml-2 h-[18px] w-[18px] shrink-0 text-zinc-400" />
          <Input
            id="discount-q"
            className="h-9 min-w-0 flex-1 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
            value={codeQuery}
            onChange={(event) => setCodeQuery(event.target.value)}
            placeholder="SUMMER"
          />
          {codeQuery ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setCodeQuery('');
                void navigate({ search: { q: '', page: 1 } });
              }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-950"
            >
              <XIcon className="size-4" />
            </button>
          ) : null}
        </div>
      </form>

      {discounts.length === 0 ? (
        <p className="mt-8 rounded-2xl bg-zinc-50 p-5 text-sm text-zinc-500" role="status">
          No discount codes yet. Use New to create your first one.
        </p>
      ) : (
        <div className="mt-8" tabIndex={0} role="region" aria-label="Discount codes">
          <Table className="min-w-[640px]">
            <TableCaption className="sr-only">Discount codes</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Code</TableHead>
                <TableHead scope="col">Discount</TableHead>
                <TableHead scope="col">Conditions</TableHead>
                <TableHead scope="col">Used</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {discounts.map((d) => (
                <TableRow
                  key={d.id}
                  className="cursor-pointer"
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest('a, button')) return;
                    openEdit(d);
                  }}
                >
                  <TableCell className="font-mono text-[13px] font-medium">{d.code}</TableCell>
                  <TableCell>{describe(d, currency)}</TableCell>
                  <TableCell className="text-zinc-500">
                    {[
                      d.min_purchase_cents > 0
                        ? `Min ${formatMoney(d.min_purchase_cents, currency)}`
                        : null,
                      d.usage_limit != null ? `Limit ${d.usage_limit}` : null,
                      d.expires_at ? `Expires ${formatDate(d.expires_at)}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'No conditions'}
                  </TableCell>
                  <TableCell className="text-zinc-500">{d.usage_count}×</TableCell>
                  <TableCell>
                    <StatusBadge value={d.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="relative inline-block text-left">
                      <button
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={rowMenu?.id === d.id}
                        aria-label={`Actions for ${d.code}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (rowMenu?.id === d.id) {
                            setRowMenu(null);
                          } else {
                            const rect = event.currentTarget.getBoundingClientRect();
                            setRowMenu({
                              id: d.id,
                              top: rect.bottom + 4,
                              right: window.innerWidth - rect.right,
                            });
                          }
                        }}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-950"
                      >
                        <EllipsisIcon className="size-4" />
                      </button>
                      {rowMenu?.id === d.id
                        ? createPortal(
                            <div
                              role="menu"
                              onClick={(event) => event.stopPropagation()}
                              style={{ top: rowMenu.top, right: rowMenu.right }}
                              className="fixed z-50 w-44 rounded-xl border border-zinc-200 bg-white p-1 shadow-lg"
                            >
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setRowMenu(null);
                                  openEdit(d);
                                }}
                                className="block w-full rounded-lg px-3 py-2 text-left text-[13px] font-medium text-zinc-950 transition-colors hover:bg-zinc-50"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                disabled={busy}
                                onClick={() => {
                                  setRowMenu(null);
                                  void run(
                                    'discount.toggle',
                                    { discountId: d.id, active: d.status !== 'active' },
                                    `${d.code} is now ${d.status !== 'active' ? 'active' : 'inactive'}.`
                                  );
                                }}
                                className="block w-full rounded-lg px-3 py-2 text-left text-[13px] font-medium text-zinc-950 transition-colors hover:bg-zinc-50 disabled:opacity-40"
                              >
                                {d.status === 'active' ? 'Deactivate' : 'Activate'}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                disabled={busy}
                                onClick={() => {
                                  setRowMenu(null);
                                  setDeleteTarget(d);
                                }}
                                className="block w-full rounded-lg px-3 py-2 text-left text-[13px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40"
                              >
                                Delete
                              </button>
                            </div>,
                            document.body
                          )
                        : null}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <AdminPagination
        label="Discounts pagination"
        page={page}
        total={total}
        pageSize={pageSize}
        onPage={(next) => void navigate({ search: { q: search.q, page: next } })}
      />

      <Sheet
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
        <SheetContent
          className="w-full gap-0 overflow-hidden p-0 sm:max-w-2xl"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <SheetHeader className="p-5 pr-14 pb-0 sm:p-6 sm:pr-14 sm:pb-0">
            <SheetTitle>{editingId ? (editing?.code ?? form.code) : 'New discount'}</SheetTitle>
            <SheetDescription>
              {editingId
                ? editing
                  ? describe(editing, currency)
                  : ''
                : 'Create a code customers can enter at checkout.'}
            </SheetDescription>
          </SheetHeader>
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
        </SheetContent>
      </Sheet>

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

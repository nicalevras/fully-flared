import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { createServerFn, useServerFn } from '@tanstack/react-start';
import * as z from 'zod';
import { ChevronDownIcon, ChevronRightIcon, MinusIcon, PlusIcon, XIcon } from 'lucide-react';
import { staffMiddleware } from '../../server/staff-middleware';
import { validateServerInput } from '../../server/function-boundary';
import { useAdminAction } from '../../components/AdminNav';
import {
  adminInventoryList,
  inventoryListInputSchema,
  type InventoryProductGroup,
  type InventorySkuRow,
} from '../../server/admin-inventory';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../components/AdminActionFeedback';
import { AdminDataTableShell, AdminRowActions } from '../../components/AdminDataTable';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { pageSub, pageTitle } from '../../components/ui';
import { StatusBadge } from '../../components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ColumnDef, OnChangeFn, PaginationState } from '@tanstack/react-table';
import {
  DataTable,
  DataTableSearch,
  dataTableControlClassName,
} from '../../components/ui/data-table';
import type { DataTableFeatures } from '../../components/data-table-features';
import { isPageSize, pageSizeOptions } from '../../schemas/pagination';
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
import { Switch } from '@/components/ui/switch';

const getList = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(inventoryListInputSchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    return adminInventoryList(env.DB, data);
  });

type InventoryDetail = {
  sku: string;
  variantTitle: string;
  productId: string;
  productTitle: string;
  onHand: number;
  reserved: number;
  available: number;
  history: Array<{
    id: string;
    delta_on_hand: number;
    delta_reserved: number;
    reason: string;
    created_at: string;
  }>;
};

const skuDetailInput = z.object({ sku: z.string().max(100) });

const getSkuDetail = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(skuDetailInput))
  .handler(async ({ data }): Promise<InventoryDetail | null> => {
    const { env } = await import('cloudflare:workers');
    const db = env.DB;
    const head = await db
      .prepare(
        `SELECT v.sku, v.title AS variantTitle, v.product_id AS productId, p.title AS productTitle,
                COALESCE(s.on_hand, 0) AS onHand, COALESCE(s.reserved, 0) AS reserved
         FROM variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN stock s ON s.sku = v.sku
         WHERE v.sku = ?`
      )
      .bind(data.sku.trim())
      .first<{
        sku: string;
        variantTitle: string;
        productId: string;
        productTitle: string;
        onHand: number;
        reserved: number;
      }>();
    if (!head) return null;
    const history = await db
      .prepare(
        'SELECT id, delta_on_hand, delta_reserved, reason, created_at FROM stock_ledger WHERE sku = ? ORDER BY created_at DESC, id DESC LIMIT 50'
      )
      .bind(head.sku)
      .all<InventoryDetail['history'][number]>();
    return { ...head, available: head.onHand - head.reserved, history: history.results };
  });

export const Route = createFileRoute('/admin/inventory')({
  staleTime: 30_000,
  validateSearch: (search: {
    q?: unknown;
    page?: unknown;
    low?: unknown;
    sku?: unknown;
    size?: unknown;
  }) => ({
    q: typeof search.q === 'string' ? search.q : '',
    page:
      typeof search.page === 'number' && Number.isInteger(search.page) && search.page > 0
        ? search.page
        : 1,
    low: search.low === true || search.low === 'true',
    sku: typeof search.sku === 'string' && search.sku ? search.sku : undefined,
    size: isPageSize(search.size) ? search.size : undefined,
  }),
  loaderDeps: ({ search }) => {
    const { sku: _sku, ...rest } = search;
    return rest;
  },
  loader: async ({ deps }) => getList({ data: deps }),
  component: AdminInventory,
});

type InventoryTableRow =
  | { kind: 'product'; group: InventoryProductGroup }
  | { kind: 'sku'; group: InventoryProductGroup; sku: InventorySkuRow };

type StagedAdjustment = {
  total: string;
  reason: string;
  note: string;
  operationId: string;
  onHand: number;
};

function StockStepper({
  sku,
  value,
  disabled,
  onValue,
}: {
  sku: string;
  value: string;
  disabled: boolean;
  onValue: (raw: string | null) => void;
}) {
  const parsed = Number(value);
  const total = Number.isInteger(parsed) ? parsed : 0;
  return (
    <span className="inline-flex items-center rounded-full border border-zinc-300">
      <button
        type="button"
        aria-label={`Decrease stock for ${sku}`}
        disabled={disabled || total <= 0}
        onClick={() => onValue(String(total - 1))}
        className="flex h-9 w-8 items-center justify-center text-zinc-600 transition-colors hover:text-zinc-950 disabled:opacity-40"
      >
        <MinusIcon className="size-4" />
      </button>
      <input
        inputMode="numeric"
        aria-label={`Stock total for ${sku}`}
        className="w-12 bg-transparent text-center text-sm font-medium text-zinc-950 outline-none"
        value={value}
        onChange={(event) => onValue(event.target.value)}
        onBlur={(event) => {
          if (event.target.value.trim() === '') onValue(null);
        }}
      />
      <button
        type="button"
        aria-label={`Increase stock for ${sku}`}
        disabled={disabled}
        onClick={() => onValue(String(total + 1))}
        className="flex h-9 w-8 items-center justify-center text-zinc-600 transition-colors hover:text-zinc-950 disabled:opacity-40"
      >
        <PlusIcon className="size-4" />
      </button>
    </span>
  );
}

function AdminInventory() {
  const adminAction = useAdminAction();
  const router = useRouter();
  const { products, total, page, pageSize } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const navigateAll = useNavigate();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [staged, setStaged] = useState<Record<string, StagedAdjustment>>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);

  useEffect(() => setExpanded({}), [search.q, search.page, search.low]);

  const skuRows = useMemo(() => {
    const map = new Map<string, InventorySkuRow>();
    for (const group of products) for (const row of group.skus) map.set(row.sku, row);
    return map;
  }, [products]);

  const dirtyEntries = useMemo(
    () =>
      Object.entries(staged).filter(([sku, entry]) => {
        const onHand = skuRows.get(sku)?.onHand ?? entry.onHand;
        const next = Number(entry.total);
        return Number.isInteger(next) && next >= 0 && next !== onHand;
      }),
    [staged, skuRows]
  );

  function stageFromDrawer(sku: string, entry: StagedAdjustment | null) {
    setStaged((current) => {
      const next = { ...current };
      if (entry === null) delete next[sku];
      else next[sku] = entry;
      return next;
    });
  }

  async function saveAll() {
    setBusy(true);
    const ordered = [...dirtyEntries].sort(([a], [b]) => a.localeCompare(b));
    const remaining = { ...staged };
    const failed: string[] = [];
    let applied = 0;
    for (const [sku, entry] of ordered) {
      const onHand = skuRows.get(sku)?.onHand ?? entry.onHand;
      const delta = Number(entry.total) - onHand;
      if (delta === 0) {
        delete remaining[sku];
        continue;
      }
      const result = await adminAction('stock.adjust', {
        sku,
        delta,
        reason: entry.reason,
        note: entry.note,
        operationId: entry.operationId,
      });
      if (result.ok) {
        applied += 1;
        delete remaining[sku];
      } else {
        failed.push(sku);
      }
    }
    setStaged(remaining);
    setBusy(false);
    if (failed.length === 0) {
      setFeedback({
        kind: 'status',
        message: applied === 1 ? 'Stock updated for 1 SKU.' : `Stock updated for ${applied} SKUs.`,
      });
    } else {
      setFeedback({
        kind: 'error',
        message: `Saved ${applied} of ${ordered.length} adjustments. Still staged: ${failed.join(', ')}.`,
      });
    }
    if (applied > 0) void router.invalidate();
  }

  function isExpanded(group: InventoryProductGroup): boolean {
    return expanded[group.id] ?? false;
  }

  const tableData = useMemo<InventoryTableRow[]>(() => {
    const rows: InventoryTableRow[] = [];
    for (const group of products) {
      rows.push({ kind: 'product', group });
      if (expanded[group.id] ?? false)
        for (const sku of group.skus) rows.push({ kind: 'sku', group, sku });
    }
    return rows;
  }, [products, expanded]);

  const inventoryColumns: ColumnDef<DataTableFeatures, InventoryTableRow>[] = [
    {
      id: 'product',
      accessorFn: (row) => (row.kind === 'product' ? row.group.title : row.sku.sku),
      header: 'Product',
      cell: ({ row }) => {
        const item = row.original;
        if (item.kind === 'sku') {
          const skuRow = item.sku;
          return (
            <div className="pl-12 whitespace-normal">
              <span className="font-medium text-zinc-950">{skuRow.sku}</span>
              <span className="block text-[13px] text-zinc-500">{skuRow.variantTitle}</span>
              {skuRow.available <= 5 ? (
                <span className="mt-1 inline-block rounded-full bg-yellow-50 px-2 py-0.5 text-[11px] font-medium text-yellow-800 ring-1 ring-yellow-600/20 ring-inset">
                  Low
                </span>
              ) : null}
            </div>
          );
        }
        const group = item.group;
        const open = isExpanded(group);
        return (
          <span className="flex items-center gap-3 whitespace-normal">
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} ${group.title}`}
              onClick={() => setExpanded((current) => ({ ...current, [group.id]: !open }))}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-950"
            >
              {open ? (
                <ChevronDownIcon className="size-4" />
              ) : (
                <ChevronRightIcon className="size-4" />
              )}
            </button>
            {group.image_key ? (
              <img
                src={`/media/${group.image_key}`}
                alt=""
                className="h-10 w-10 shrink-0 rounded-lg object-cover"
              />
            ) : (
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-sm font-medium text-zinc-500"
                aria-hidden
              >
                {group.title.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span>
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-zinc-950">{group.title}</span>
                <StatusBadge value={group.status} />
              </span>
              <span className="block text-[13px] text-zinc-500">
                {group.variantCount} {group.variantCount === 1 ? 'variant' : 'variants'}
                {group.lowCount > 0 ? ` · ${group.lowCount} low` : ''}
              </span>
            </span>
          </span>
        );
      },
    },
    {
      id: 'onHand',
      accessorFn: (row) => (row.kind === 'product' ? row.group.onHand : row.sku.onHand),
      header: 'On hand',
      cell: ({ row }) => (
        <span>
          {row.original.kind === 'product' ? row.original.group.onHand : row.original.sku.onHand}
        </span>
      ),
    },
    {
      id: 'reserved',
      accessorFn: (row) => (row.kind === 'product' ? row.group.reserved : row.sku.reserved),
      header: 'Reserved',
      cell: ({ row }) => (
        <span>
          {row.original.kind === 'product'
            ? row.original.group.reserved
            : row.original.sku.reserved}
        </span>
      ),
    },
    {
      id: 'available',
      accessorFn: (row) => (row.kind === 'product' ? row.group.available : row.sku.available),
      header: 'Available',
      cell: ({ row }) => (
        <span>
          {row.original.kind === 'product'
            ? row.original.group.available
            : row.original.sku.available}
        </span>
      ),
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      enableHiding: false,
      cell: ({ row }) => {
        const item = row.original;
        if (item.kind === 'product') return null;
        const skuRow = item.sku;
        return (
          <div className="flex justify-end">
            <AdminRowActions label={`Actions for ${skuRow.sku}`}>
              <DropdownMenuItem
                onSelect={() =>
                  void navigate({
                    search: {
                      q: search.q,
                      page: search.page,
                      low: search.low,
                      size: search.size,
                      sku: skuRow.sku,
                    },
                  })
                }
              >
                Adjust stock
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  void navigateAll({ to: '/admin/products', search: { edit: item.group.id } })
                }
              >
                Open product
              </DropdownMenuItem>
            </AdminRowActions>
          </div>
        );
      },
    },
  ];

  const handleRowClick = (row: InventoryTableRow) => {
    if (row.kind === 'product') {
      const group = row.group;
      setExpanded((current) => ({ ...current, [group.id]: !(current[group.id] ?? false) }));
      return;
    }
    void navigate({
      search: {
        q: search.q,
        page: search.page,
        low: search.low,
        size: search.size,
        sku: row.sku.sku,
      },
    });
  };

  const handlePaginationChange: OnChangeFn<PaginationState> = (updater) => {
    const next =
      typeof updater === 'function' ? updater({ pageIndex: page - 1, pageSize }) : updater;
    void navigate({
      search: {
        q: search.q,
        page: next.pageIndex + 1,
        low: search.low,
        size: isPageSize(next.pageSize) ? next.pageSize : isPageSize(pageSize) ? pageSize : 25,
        sku: undefined,
      },
    });
  };

  return (
    <main>
      <h1 className={pageTitle}>Inventory</h1>
      <p className={pageSub}>On hand, reserved, and available by product.</p>
      <AdminActionFeedback value={feedback} />

      {products.length === 0 && !search.q && !search.low ? (
        <p className="mt-6 rounded-2xl bg-zinc-50 p-5 text-sm text-zinc-500" role="status">
          {search.q || search.low ? 'No products match that search.' : 'No products yet.'}
        </p>
      ) : (
        <div className="mt-6" tabIndex={0} role="region" aria-label="Inventory">
          <DataTable
            caption="Inventory by product"
            columns={inventoryColumns}
            data={tableData}
            pageIndex={page - 1}
            pageSize={pageSize}
            rowCount={total}
            pageSizeOptions={pageSizeOptions}
            onPaginationChange={handlePaginationChange}
            onRowClick={handleRowClick}
            getRowId={(row) =>
              row.kind === 'product' ? `product:${row.group.id}` : `sku:${row.sku.sku}`
            }
            getRowClassName={(row) => (row.kind === 'sku' ? 'bg-zinc-50/60' : undefined)}
            hideViewOptions
            toolbar={
              <DataTableSearch
                value={search.q}
                onSearch={(q) =>
                  void navigate({
                    search: {
                      q,
                      page: 1,
                      low: search.low,
                      size: search.size,
                      sku: undefined,
                    },
                  })
                }
                placeholder="Search Products"
                ariaLabel="Find a product"
              />
            }
            toolbarActions={
              <>
                <label className={`flex items-center gap-2 ${dataTableControlClassName}`}>
                  <Switch
                    checked={search.low}
                    onCheckedChange={(checked) =>
                      void navigate({
                        search: {
                          q: search.q,
                          page: 1,
                          low: checked,
                          size: search.size,
                          sku: undefined,
                        },
                      })
                    }
                  />
                  Low stock only
                </label>
              </>
            }
            tableClassName="min-w-[760px]"
          />
        </div>
      )}

      {dirtyEntries.length > 0 ? (
        <div className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-lg">
          <span className="text-sm text-zinc-500">
            {dirtyEntries.length} unsaved {dirtyEntries.length === 1 ? 'change' : 'changes'}
          </span>
          <span className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setStaged({})}
            >
              Discard
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => void saveAll()}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </span>
        </div>
      ) : null}

      {search.sku ? (
        <SkuDrawer
          key={search.sku}
          sku={search.sku}
          staged={staged[search.sku] ?? null}
          onStage={stageFromDrawer}
          onClose={() =>
            void navigate({
              search: {
                q: search.q,
                page: search.page,
                low: search.low,
                size: search.size,
                sku: undefined,
              },
            })
          }
        />
      ) : null}
    </main>
  );
}

function SkuDrawer({
  sku,
  staged,
  onStage,
  onClose,
}: {
  sku: string;
  staged: StagedAdjustment | null;
  onStage: (sku: string, entry: StagedAdjustment | null) => void;
  onClose: () => void;
}) {
  const getDetail = useServerFn(getSkuDetail);
  const [detail, setDetail] = useState<InventoryDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getDetail({ data: { sku } }).then((result) => {
      if (cancelled) return;
      setDetail(result);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [getDetail, sku]);

  const requestClose = () => {
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  return (
    <Drawer
      instant
      swipeDirection="right"
      open
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <DrawerContent
        className="w-full max-w-[calc(100vw-1rem)] gap-0 overflow-hidden p-0 sm:max-w-2xl"
        initialFocus={false}
      >
        <DrawerClose
          render={
            <Button type="button" variant="ghost" size="icon-sm" className="absolute top-3 right-3">
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          }
        />
        <DrawerHeader className="p-5 pr-14 pb-0 sm:p-6 sm:pr-14 sm:pb-0">
          <DrawerTitle>{sku}</DrawerTitle>
          <DrawerDescription>
            {detail ? `${detail.productTitle} · ${detail.variantTitle}` : 'Stock detail'}
          </DrawerDescription>
        </DrawerHeader>
        {!loaded ? (
          <p className="px-5 py-5 text-sm text-zinc-500 sm:px-6" role="status">
            Loading stock…
          </p>
        ) : !detail ? (
          <p className="px-5 py-5 text-sm text-zinc-500 sm:px-6" role="status">
            No stock record for {sku}.
          </p>
        ) : (
          <SkuDrawerForm
            key={detail.sku}
            detail={detail}
            staged={staged}
            onStage={onStage}
            onClose={onClose}
            onDirtyChange={setDirty}
          />
        )}
        <ConfirmDialog
          request={
            confirmDiscard
              ? {
                  title: 'Discard unsaved changes?',
                  body: "Your adjustment to this SKU hasn't been staged.",
                  confirmLabel: 'Discard changes',
                }
              : null
          }
          busy={false}
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false);
            onClose();
          }}
        />
      </DrawerContent>
    </Drawer>
  );
}

function SkuDrawerForm({
  detail,
  staged,
  onStage,
  onClose,
  onDirtyChange,
}: {
  detail: InventoryDetail;
  staged: StagedAdjustment | null;
  onStage: (sku: string, entry: StagedAdjustment | null) => void;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const navigate = useNavigate();
  const [total, setTotal] = useState(staged?.total ?? String(detail.onHand));
  const [reason, setReason] = useState(staged?.reason ?? 'restock');
  const [note, setNote] = useState(staged?.note ?? '');
  const initial = useMemo(
    () => ({
      total: staged?.total ?? String(detail.onHand),
      reason: staged?.reason ?? 'restock',
      note: staged?.note ?? '',
    }),
    [detail.onHand, staged]
  );
  const dirty = total !== initial.total || reason !== initial.reason || note !== initial.note;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  function stageAndClose() {
    const parsed = Number(total);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed === detail.onHand) {
      onStage(detail.sku, null);
    } else {
      onStage(detail.sku, {
        total,
        reason,
        note,
        operationId: staged?.operationId ?? crypto.randomUUID(),
        onHand: detail.onHand,
      });
    }
    onDirtyChange(false);
    onClose();
  }

  return (
    <Fragment>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            void navigate({ to: '/admin/products', search: { edit: detail.productId } })
          }
        >
          Open product
        </Button>

        <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
          <div className="rounded-xl bg-zinc-50 p-3">
            <dt className="text-xs text-zinc-500">On hand</dt>
            <dd className="text-lg font-medium text-zinc-950">{detail.onHand}</dd>
          </div>
          <div className="rounded-xl bg-zinc-50 p-3">
            <dt className="text-xs text-zinc-500">Reserved</dt>
            <dd className="text-lg font-medium text-zinc-950">{detail.reserved}</dd>
          </div>
          <div className="rounded-xl bg-zinc-50 p-3">
            <dt className="text-xs text-zinc-500">Available</dt>
            <dd className="text-lg font-medium text-zinc-950">{detail.available}</dd>
          </div>
        </dl>

        <section className="mt-6">
          <h2 className="text-sm font-medium text-zinc-950">Adjust</h2>
          <div className="mt-3 flex items-start justify-between gap-4">
            <span className="text-sm font-medium text-zinc-900">Inventory</span>
            <StockStepper
              sku={detail.sku}
              value={total}
              disabled={false}
              onValue={(raw) => setTotal(raw ?? String(detail.onHand))}
            />
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="sku-reason" className="mb-1.5">
                Reason
              </Label>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger
                  id="sku-reason"
                  className="w-full rounded-lg data-[size=default]:h-10"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="restock">Restock</SelectItem>
                  <SelectItem value="correction">Correction</SelectItem>
                  <SelectItem value="damaged">Damaged</SelectItem>
                  <SelectItem value="return">Return</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="sku-note" className="mb-1.5">
                Note (optional)
              </Label>
              <Input
                id="sku-note"
                className="rounded-lg"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          </div>
        </section>

        <section className="mt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-950">Movement history</h2>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const lines = [
                  'created_at,delta_on_hand,delta_reserved,reason',
                  ...detail.history.map(
                    (row) =>
                      `${row.created_at},${row.delta_on_hand},${row.delta_reserved},${row.reason}`
                  ),
                ];
                const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
                const link = document.createElement('a');
                link.href = url;
                link.download = `inventory-${detail.sku}.csv`;
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export CSV
            </Button>
          </div>
          {detail.history.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500" role="status">
              No movements recorded for this SKU yet.
            </p>
          ) : (
            <div className="mt-3" tabIndex={0} role="region" aria-label="Stock movements">
              <AdminDataTableShell>
                <Table className="min-w-[520px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>On hand change</TableHead>
                      <TableHead>Reserved change</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.history.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{row.created_at}</TableCell>
                        <TableCell>{row.delta_on_hand}</TableCell>
                        <TableCell>{row.delta_reserved}</TableCell>
                        <TableCell>{row.reason}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </AdminDataTableShell>
            </div>
          )}
        </section>
      </div>
      {dirty ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-100 bg-white px-5 py-3.5 sm:px-6">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Discard
          </Button>
          <Button type="button" size="sm" onClick={stageAndClose}>
            Save changes
          </Button>
        </div>
      ) : null}
    </Fragment>
  );
}

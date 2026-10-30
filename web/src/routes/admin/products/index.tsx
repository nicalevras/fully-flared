import { useState } from 'react';
import { staffMiddleware } from '../../../server/staff-middleware';
import { requireStaffPermission } from '../../../server/session';
import { useStoreCurrency } from '../../../lib/use-store-currency';
import {
  Link,
  createFileRoute,
  getRouteApi,
  useRouter,
  type SearchSchemaInput,
} from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getProductDetail, ProductEditor } from '../../../components/ProductEditor';
import { ProductCreateDrawer } from '../../../components/ProductCreateDrawer';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import {
  adminProductDiscovery,
  productDiscoveryInputSchema,
  type AdminProductRow,
} from '../../../server/admin-product-discovery';
import {
  isProductSort,
  isProductStatusFilter,
  normalizeProductSearch,
} from '../../../lib/product-search';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../../components/AdminActionFeedback';
import { validateServerInput } from '../../../server/function-boundary';
import { useAdminAction } from '../../../components/AdminNav';
import { formatMoney } from '../../../lib/format';
import { roleCan } from '../../../lib/permissions';
import { StatusBadge } from '../../../components/StatusBadge';
import { btnSmall, pageSub, pageTitle } from '../../../components/ui';
import { Button } from '@/components/ui/button';
import { PlusIcon, XIcon } from 'lucide-react';
import { AdminRowActions } from '../../../components/AdminDataTable';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { ColumnDef } from '@tanstack/react-table';
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
} from '@/components/ui/select';
import type { DataTableFeatures } from '../../../components/data-table-features';

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(productDiscoveryInputSchema))
  .handler(async ({ data, context }) => {
    requireStaffPermission(context.staff, 'product', 'view');
    const { env } = await import('cloudflare:workers');
    return adminProductDiscovery(env.DB, data);
  });

export const Route = createFileRoute('/admin/products/')({
  validateSearch: (
    search: {
      q?: unknown;
      mode?: unknown;
      status?: unknown;
      sort?: unknown;
      cursor?: unknown;
      edit?: unknown;
    } & SearchSchemaInput
  ) => ({
    ...normalizeProductSearch(search),
    edit: typeof search.edit === 'string' && search.edit ? search.edit : undefined,
  }),
  loaderDeps: ({ search: { q, mode, status, sort, cursor, edit } }) => ({
    q,
    mode,
    status,
    sort,
    cursor,
    edit: edit ?? '',
  }),
  loader: async ({ deps: { edit, ...list } }) => {
    const [data, detail] = await Promise.all([
      getData({ data: list }),
      // A missing or unreadable product opens the not-found drawer.
      edit ? getProductDetail({ data: edit }).catch(() => null) : null,
    ]);
    return { ...data, detail };
  },
  pendingComponent: () => (
    <p className="p-5 text-sm" role="status">
      Loading products…
    </p>
  ),
  errorComponent: ({ reset }) => (
    <div className="p-5">
      <p className="text-sm text-red-700" role="alert">
        Products could not be loaded.
      </p>
      <button className={btnSmall} onClick={reset}>
        Try again
      </button>
    </div>
  ),
  component: AdminProducts,
});

const adminApi = getRouteApi('/admin');

function AdminProducts() {
  const adminAction = useAdminAction();
  const { staff } = adminApi.useRouteContext();
  const canCreate = roleCan(staff?.role, 'product', 'create');

  const currency = useStoreCurrency();
  const { products, nextCursor, previousCursor, state, detail } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [msg, setMsg] = useState<AdminActionFeedbackState>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const openEditor = (id: string) => void navigate({ search: { ...search, edit: id } });
  const closeEditor = () => void navigate({ search: { ...search, edit: undefined } });
  const refreshDetail = () => router.invalidate({ sync: true });
  const pillWhite =
    'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-zinc-300 bg-white px-4 text-[13px] font-medium text-zinc-950 transition-colors hover:border-zinc-950 disabled:pointer-events-none disabled:opacity-40';
  const statuses = [
    ['all', 'All'],
    ['active', 'Active'],
    ['draft', 'Draft'],
    ['archived', 'Archived'],
  ] as const;

  const productColumns: ColumnDef<DataTableFeatures, AdminProductRow>[] = [
    {
      id: 'product',
      header: 'Product',
      enableHiding: false,
      cell: ({ row }) => {
        const p = row.original;
        return (
          <Link
            to="/admin/products"
            search={{ ...search, edit: p.id }}
            className="flex items-center gap-3 whitespace-normal"
          >
            {p.image_key ? (
              <img
                src={`/media/${p.image_key}`}
                alt=""
                className="h-10 w-10 shrink-0 rounded-lg object-cover"
              />
            ) : (
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-sm font-medium text-zinc-500"
                aria-hidden
              >
                {p.title.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span>
              <span className="font-medium text-zinc-950 hover:underline">{p.title}</span>
              <span className="block text-[13px] text-zinc-500">/{p.slug}</span>
            </span>
          </Link>
        );
      },
    },
    {
      id: 'price',
      accessorFn: (row) => row.price_cents,
      header: 'Price',
      cell: ({ row }) => {
        const p = row.original;
        return (
          <span>
            {p.price_cents != null
              ? p.max_price_cents != null && p.max_price_cents !== p.price_cents
                ? `${formatMoney(p.price_cents, currency)} – ${formatMoney(p.max_price_cents, currency)}`
                : formatMoney(p.price_cents, currency)
              : '-'}
          </span>
        );
      },
    },
    {
      id: 'inventory',
      accessorFn: (row) => row.available,
      header: 'Inventory',
      cell: ({ row }) => {
        const p = row.original;
        return (
          <>
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`h-2 w-2 shrink-0 rounded-full ${
                  p.available <= 0
                    ? 'bg-red-500'
                    : p.available <= 5
                      ? 'bg-amber-500'
                      : 'bg-zinc-300'
                }`}
              />
              {p.available <= 0 ? (
                <span className="font-medium text-red-600">Out of stock</span>
              ) : p.available <= 5 ? (
                <span className="font-medium text-yellow-800">{p.available} left</span>
              ) : (
                `${p.available} in stock`
              )}
            </span>
            <span className="block text-[13px] text-zinc-500">
              {p.variant_count} {p.variant_count === 1 ? 'variant' : 'variants'}
            </span>
          </>
        );
      },
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
        const p = row.original;
        return (
          <div className="flex justify-end">
            <AdminRowActions label={`Actions for ${p.title}`}>
              <DropdownMenuItem asChild>
                <Link to="/admin/products" search={{ ...search, edit: p.id }}>
                  Edit
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={async () => {
                  const next = p.status === 'active' ? 'draft' : 'active';
                  const r = await adminAction('product.updateStatus', {
                    productId: p.id,
                    status: next,
                  });
                  if (r.ok) {
                    setMsg({ kind: 'status', message: `${p.title} is now ${next}.` });
                    router.invalidate();
                  } else setMsg({ kind: 'error', message: r.error ?? 'Failed' });
                }}
              >
                {p.status === 'active' ? 'Move to draft' : 'Publish'}
              </DropdownMenuItem>
            </AdminRowActions>
          </div>
        );
      },
    },
  ];

  return (
    <main>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className={pageTitle}>Products</h1>
          <p className={pageSub}>Click a product to edit its variants, stock, and images.</p>
        </div>
        <span className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/admin/products/import">Import CSV</Link>
          </Button>
        </span>
      </div>
      <AdminActionFeedback value={msg} />

      <section className="mt-6" aria-label="Product results">
        <div tabIndex={0} role="region" aria-label="Product results">
          {/* Cursor pages only: the Worker hands back next/previous cursors,
                not a total. The footer override owns navigation. */}
          <DataTable
            caption="Products"
            emptyMessage={
              <div className="rounded-2xl bg-zinc-50 p-5">
                <p className="text-sm text-zinc-500" role="status">
                  {state === 'refine'
                    ? 'This search is too broad to display safely. Try a more specific title.'
                    : search.q
                      ? 'No matching products. Try another title.'
                      : search.status !== 'all'
                        ? `No ${search.status} products. Try another status or reset the filters.`
                        : 'No products yet. Use New to create your first product.'}
                </p>
                {search.cursor ? (
                  <button
                    className={`${pillWhite} mt-3`}
                    onClick={() => void navigate({ search: { ...search, cursor: undefined } })}
                  >
                    Back to first page
                  </button>
                ) : null}
                {search.q || search.status !== 'all' || search.sort !== 'newest' ? (
                  <button
                    className={`${pillWhite} mt-3 ml-2`}
                    onClick={() => {
                      void navigate({
                        search: {
                          q: '',
                          mode: null,
                          status: 'all',
                          sort: 'newest',
                          cursor: undefined,
                        },
                      });
                    }}
                  >
                    Reset filters
                  </button>
                ) : null}
              </div>
            }
            columns={productColumns}
            data={products}
            pageIndex={0}
            pageSize={50}
            rowCount={0}
            onPaginationChange={() => undefined}
            onRowClick={(row) => openEditor(row.id)}
            paginationFooter={
              previousCursor || nextCursor ? (
                <div className="flex justify-between gap-3 px-2 py-4">
                  {previousCursor ? (
                    <button
                      type="button"
                      className={pillWhite}
                      onClick={() =>
                        void navigate({ search: { ...search, cursor: previousCursor } })
                      }
                    >
                      Previous 50 products
                    </button>
                  ) : (
                    <span />
                  )}
                  {nextCursor ? (
                    <button
                      type="button"
                      className={pillWhite}
                      onClick={() => void navigate({ search: { ...search, cursor: nextCursor } })}
                    >
                      Next 50 products
                    </button>
                  ) : null}
                </div>
              ) : (
                <></>
              )
            }
            toolbar={
              <div className="min-w-0 flex-1">
                <DataTableSearch
                  value={search.q}
                  onSearch={(q) =>
                    void navigate({
                      search: {
                        q,
                        mode: q ? 'title' : null,
                        status: search.status,
                        sort: search.sort,
                        cursor: undefined,
                      },
                    })
                  }
                  placeholder="Search Products"
                  ariaLabel="Find products"
                />
              </div>
            }
            toolbarActions={
              <>
                <Select
                  value={search.status}
                  onValueChange={(value) => {
                    if (isProductStatusFilter(value))
                      void navigate({
                        search: { ...search, status: value, cursor: undefined },
                      });
                  }}
                >
                  <SelectTrigger
                    aria-label="Filter by status"
                    className={dataTableControlClassName}
                  >
                    <SelectValue>Status</SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    align="end"
                    sideOffset={4}
                    className={dataTableMenuClassName}
                  >
                    {statuses.map(([value, label]) => (
                      <SelectItem className={dataTableMenuItemClassName} key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={search.sort}
                  onValueChange={(value) => {
                    if (isProductSort(value))
                      void navigate({ search: { ...search, sort: value, cursor: undefined } });
                  }}
                >
                  <SelectTrigger aria-label="Sort products" className={dataTableControlClassName}>
                    <SelectValue>Sort</SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    align="end"
                    sideOffset={4}
                    className={dataTableMenuClassName}
                  >
                    <SelectItem className={dataTableMenuItemClassName} value="newest">
                      Newest
                    </SelectItem>
                    <SelectItem className={dataTableMenuItemClassName} value="oldest">
                      Oldest
                    </SelectItem>
                    <SelectItem className={dataTableMenuItemClassName} value="title">
                      Title A–Z
                    </SelectItem>
                    <SelectItem className={dataTableMenuItemClassName} value="updated">
                      Recently updated
                    </SelectItem>
                  </SelectContent>
                </Select>
              </>
            }
            toolbarEnd={
              canCreate ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setCreateOpen(true)}
                  className="h-8 rounded-md bg-zinc-950 text-white shadow-none hover:bg-zinc-800"
                >
                  <PlusIcon /> New
                </Button>
              ) : null
            }
            tableClassName="min-w-[680px]"
          />
        </div>
      </section>
      {canCreate ? (
        <ProductCreateDrawer
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(id) => {
            setCreateOpen(false);
            router.invalidate();
            if (id) openEditor(id);
          }}
        />
      ) : null}
      {search.edit && !detail ? (
        <Drawer
          instant
          swipeDirection="right"
          open
          onOpenChange={(next) => {
            if (!next) closeEditor();
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
              <DrawerTitle>Product not found</DrawerTitle>
              <DrawerDescription>This product does not exist.</DrawerDescription>
            </DrawerHeader>
            <div className="px-5 py-5 sm:px-6">
              <Button type="button" onClick={closeEditor}>
                Back to products
              </Button>
            </div>
          </DrawerContent>
        </Drawer>
      ) : null}
      {search.edit && detail?.id === search.edit ? (
        <ProductEditor
          key={detail.id}
          product={detail}
          open
          onClose={closeEditor}
          refresh={refreshDetail}
        />
      ) : null}
    </main>
  );
}

import { useEffect, useState } from 'react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table';
import { staffMiddleware } from '../../../server/staff-middleware';
import { useStoreCurrency } from '../../../lib/use-store-currency';
import {
  Link,
  createFileRoute,
  getRouteApi,
  useRouter,
  type SearchSchemaInput,
} from '@tanstack/react-router';
import { createServerFn, useServerFn } from '@tanstack/react-start';
import {
  getProductDetail,
  ProductEditor,
  type ProductDetail,
} from '../../../components/ProductEditor';
import { ProductCreateSheet } from '../../../components/ProductCreateSheet';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  adminProductDiscovery,
  productDiscoveryInputSchema,
} from '../../../server/admin-product-discovery';
import {
  isProductMode,
  isProductSort,
  isProductStatusFilter,
  normalizeProductSearch,
  type ProductMode,
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
import { SearchIcon } from '../../../components/icons';
import { btnSmall } from '../../../components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(productDiscoveryInputSchema))
  .handler(async ({ data }) => {
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
  loaderDeps: ({ search }) => {
    const { edit: _edit, ...rest } = search;
    return rest;
  },
  loader: async ({ deps }) => getData({ data: deps }),
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
  const { products, nextCursor, previousCursor, state } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [msg, setMsg] = useState<AdminActionFeedbackState>(null);
  const [query, setQuery] = useState(search.q);
  const [mode, setMode] = useState<ProductMode>(search.mode ?? 'title');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const detailFn = useServerFn(getProductDetail);
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [detailFor, setDetailFor] = useState('');
  useEffect(() => {
    if (!search.edit) {
      setDetail(null);
      setDetailFor('');
      return;
    }
    let cancelled = false;
    setDetailFor('');
    detailFn({ data: search.edit })
      .then((d) => {
        if (!cancelled) {
          setDetail(d);
          setDetailFor(search.edit!);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetail(null);
          setDetailFor(search.edit!);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.edit]);
  const openEditor = (id: string) => void navigate({ search: { ...search, edit: id } });
  const closeEditor = () => void navigate({ search: { ...search, edit: undefined } });
  const refreshDetail = async () => {
    if (search.edit) {
      const d = await detailFn({ data: search.edit });
      setDetail(d);
      setDetailFor(search.edit);
    }
    router.invalidate();
  };
  useEffect(() => {
    setQuery(search.q);
    setMode(search.mode ?? 'title');
  }, [search.q, search.mode]);
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  const pillWhite =
    'inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-zinc-300 bg-white px-4 text-[13px] font-medium text-zinc-950 transition-colors hover:border-zinc-950 disabled:pointer-events-none disabled:opacity-40';
  const statuses = [
    ['all', 'All'],
    ['active', 'Active'],
    ['draft', 'Draft'],
    ['archived', 'Archived'],
  ] as const;

  return (
    <main>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[28px] leading-tight font-medium tracking-tight text-zinc-950">
            Products
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Click a product to edit its variants, stock, and images.
          </p>
        </div>
        <span className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/admin/products/import">Import CSV</Link>
          </Button>
          {canCreate ? (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              + Add product
            </Button>
          ) : null}
        </span>
      </div>
      <AdminActionFeedback value={msg} />

      <form
        className="mt-8"
        onSubmit={(event) => {
          event.preventDefault();
          const q = query.trim();
          void navigate({
            search: {
              q,
              mode: q ? mode : null,
              status: search.status,
              sort: search.sort,
              cursor: undefined,
            },
          });
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-56 flex-1 items-center gap-1 rounded-full bg-zinc-50 p-1 transition-shadow focus-within:ring-2 focus-within:ring-zinc-950/70">
            <Select
              value={mode}
              onValueChange={(value) => {
                if (isProductMode(value)) setMode(value);
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="Search by"
                className="shrink-0 border-0 bg-transparent shadow-none focus-visible:ring-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="title">Title</SelectItem>
                <SelectItem value="sku">SKU</SelectItem>
              </SelectContent>
            </Select>
            <span aria-hidden="true" className="h-5 w-px shrink-0 bg-zinc-950/10" />
            <SearchIcon className="ml-2 h-[18px] w-[18px] shrink-0 text-zinc-400" />
            <Input
              id="product-query"
              aria-label="Find products"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search products"
              maxLength={200}
              className="h-9 min-w-0 flex-1 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
            />
            {query ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  void navigate({
                    search: {
                      q: '',
                      mode: null,
                      status: search.status,
                      sort: search.sort,
                      cursor: undefined,
                    },
                  });
                }}
              >
                <span aria-hidden="true">✕</span>
              </Button>
            ) : null}
          </div>
          <ToggleGroup
            type="single"
            spacing={0}
            value={search.status}
            onValueChange={(value) => {
              if (isProductStatusFilter(value))
                void navigate({ search: { ...search, status: value, cursor: undefined } });
            }}
            aria-label="Filter by status"
            className="rounded-full bg-zinc-50 p-1"
          >
            {statuses.map(([value, label]) => (
              <ToggleGroupItem
                key={value}
                value={value}
                className="rounded-full px-3.5 text-[13px] text-zinc-500 data-[state=on]:bg-zinc-950 data-[state=on]:text-white"
              >
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Select
            value={search.sort}
            onValueChange={(value) => {
              if (isProductSort(value))
                void navigate({ search: { ...search, sort: value, cursor: undefined } });
            }}
          >
            <SelectTrigger aria-label="Sort products" className="bg-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="oldest">Oldest</SelectItem>
              <SelectItem value="title">Title A–Z</SelectItem>
              <SelectItem value="updated">Recently updated</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {mode !== 'title' ? (
          <p className="mt-2 text-xs text-zinc-500">SKU search is case-sensitive.</p>
        ) : null}
      </form>

      <section className="mt-6" aria-label="Product results">
        {state === 'refine' ? (
          <p className="rounded-2xl bg-zinc-50 p-5 text-sm text-zinc-600" role="status">
            This search is too broad to display safely. Try a more specific title or SKU.
          </p>
        ) : products.length === 0 ? (
          <div className="rounded-2xl bg-zinc-50 p-5">
            <p className="text-sm text-zinc-500" role="status">
              {search.q
                ? 'No matching products. Try another title or SKU.'
                : search.status !== 'all'
                  ? `No ${search.status} products. Try another status or reset the filters.`
                  : 'No products yet. Create your first product below.'}
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
                  setQuery('');
                  void navigate({
                    search: { q: '', mode: null, status: 'all', sort: 'newest', cursor: undefined },
                  });
                }}
              >
                Reset filters
              </button>
            ) : null}
          </div>
        ) : (
          <div tabIndex={0} role="region" aria-label="Product results">
            <Table className="min-w-[680px]">
              <TableCaption className="sr-only">Products</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Product</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Price</TableHead>
                  <TableHead scope="col">Inventory</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((p, index) => (
                  <TableRow
                    key={p.id}
                    className="cursor-pointer"
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest('a, button, select, input')) return;
                      openEditor(p.id);
                    }}
                  >
                    <TableCell className="whitespace-normal">
                      <Link
                        to="/admin/products"
                        search={{ ...search, edit: p.id }}
                        className="flex items-center gap-3"
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
                          <span className="font-medium text-zinc-950 hover:underline">
                            {p.title}
                          </span>
                          <span className="block text-[13px] text-zinc-500">/{p.slug}</span>
                          {p.matched_skus.map((match) => (
                            <span key={match.sku} className="block text-[13px] text-zinc-500">
                              {match.sku} · {match.title}
                            </span>
                          ))}
                          {p.matched_sku_count > 3 ? (
                            <span className="block text-[13px] text-zinc-500">
                              +{p.matched_sku_count - 3} more matching SKUs
                            </span>
                          ) : null}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={p.status} />
                    </TableCell>
                    <TableCell>
                      {p.price_cents != null
                        ? p.max_price_cents != null && p.max_price_cents !== p.price_cents
                          ? `${formatMoney(p.price_cents, currency)} – ${formatMoney(p.max_price_cents, currency)}`
                          : formatMoney(p.price_cents, currency)
                        : '-'}
                    </TableCell>
                    <TableCell>
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
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="relative inline-block text-left">
                        <button
                          type="button"
                          aria-haspopup="menu"
                          aria-expanded={menuFor === p.id}
                          aria-label={`Actions for ${p.title}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuFor(menuFor === p.id ? null : p.id);
                          }}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none font-medium text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-950"
                        >
                          …
                        </button>
                        {menuFor === p.id ? (
                          <span
                            role="menu"
                            onClick={(event) => event.stopPropagation()}
                            className={`absolute right-0 z-20 block w-44 rounded-xl border border-zinc-200 bg-white p-1 shadow-lg ${
                              index >= products.length - 2 ? 'bottom-full mb-1' : 'top-full mt-1'
                            }`}
                          >
                            <Link
                              role="menuitem"
                              to="/admin/products"
                              search={{ ...search, edit: p.id }}
                              onClick={() => setMenuFor(null)}
                              className="block rounded-lg px-3 py-2 text-[13px] font-medium text-zinc-950 transition-colors hover:bg-zinc-50"
                            >
                              Edit
                            </Link>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={async () => {
                                setMenuFor(null);
                                const next = p.status === 'active' ? 'draft' : 'active';
                                const r = await adminAction('product.updateStatus', {
                                  productId: p.id,
                                  status: next,
                                });
                                if (r.ok) {
                                  setMsg({
                                    kind: 'status',
                                    message: `${p.title} is now ${next}.`,
                                  });
                                  router.invalidate();
                                } else setMsg({ kind: 'error', message: r.error ?? 'Failed' });
                              }}
                              className="block w-full rounded-lg px-3 py-2 text-left text-[13px] font-medium text-zinc-950 transition-colors hover:bg-zinc-50"
                            >
                              {p.status === 'active' ? 'Move to draft' : 'Publish'}
                            </button>
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      {previousCursor || nextCursor ? (
        <div className="mt-4 flex justify-between gap-3">
          {previousCursor ? (
            <button
              className={pillWhite}
              onClick={() => void navigate({ search: { ...search, cursor: previousCursor } })}
            >
              Previous 50 products
            </button>
          ) : (
            <span />
          )}
          {nextCursor ? (
            <button
              className={pillWhite}
              onClick={() => void navigate({ search: { ...search, cursor: nextCursor } })}
            >
              Next 50 products
            </button>
          ) : null}
        </div>
      ) : null}
      {canCreate ? (
        <ProductCreateSheet
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(id) => {
            setCreateOpen(false);
            router.invalidate();
            if (id) openEditor(id);
          }}
        />
      ) : null}
      {search.edit && detailFor === search.edit && !detail ? (
        <Sheet
          open
          onOpenChange={(next) => {
            if (!next) closeEditor();
          }}
        >
          <SheetContent
            className="w-full gap-0 overflow-hidden p-0 sm:max-w-4xl"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <SheetHeader className="p-5 pr-14 pb-0 sm:p-6 sm:pr-14 sm:pb-0">
              <SheetTitle>Product not found</SheetTitle>
              <SheetDescription>This product does not exist.</SheetDescription>
            </SheetHeader>
            <div className="px-5 py-5 sm:px-6">
              <Button type="button" onClick={closeEditor}>
                Back to products
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
      {search.edit && detail && detailFor === search.edit ? (
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

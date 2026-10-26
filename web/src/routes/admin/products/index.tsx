import { useEffect, useState } from 'react';
import { staffMiddleware } from '../../../server/staff-middleware';
import { useStoreCurrency } from '../../../lib/use-store-currency';
import { Link, createFileRoute, useRouter, type SearchSchemaInput } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
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
import { formatMoney, slugify } from '../../../lib/format';
import { StatusBadge } from '../../../components/StatusBadge';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import {
  btnGhost,
  btnPrimary,
  btnSmall,
  cardCls,
  hintCls,
  inputCls,
  labelCls,
  pageSub,
  pageTitle,
  tableCls,
  tableWrap,
  textareaCls,
} from '../../../components/ui';

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(productDiscoveryInputSchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    return adminProductDiscovery(env.DB, data);
  });

export const Route = createFileRoute('/admin/products/')({
  validateSearch: (search: { q?: unknown; mode?: unknown; status?: unknown; sort?: unknown; cursor?: unknown } & SearchSchemaInput) =>
    normalizeProductSearch(search),
  loaderDeps: ({ search }) => search,
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

function AdminProducts() {
  const adminAction = useAdminAction();

  const currency = useStoreCurrency();
  const { products, nextCursor, previousCursor, state } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [form, setForm] = useState({ title: '', slug: '', sku: '', price: '29.99', stock: '10' });
  const [csv, setCsv] = useState('title,slug,sku,price_cents,stock\n');
  const [adjust, setAdjust] = useState({ sku: '', delta: '10' });
  const [msg, setMsg] = useState<AdminActionFeedbackState>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(search.q);
  const [mode, setMode] = useState<ProductMode>(search.mode ?? 'title');
  useEffect(() => {
    setQuery(search.q);
    setMode(search.mode ?? 'title');
  }, [search.q, search.mode]);

  return (
    <main>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className={pageTitle}>Products</h1>
          <p className={pageSub}>
            Find a product by title or SKU. Click a product to edit its variants, stock, and images.
          </p>
        </div>
      </div>
      <AdminActionFeedback value={msg} />

      <form
        className={`${cardCls} mt-5 flex flex-wrap items-end gap-3 p-4`}
        onSubmit={(event) => {
          event.preventDefault();
          const q = query.trim();
          void navigate({
            search: { q, mode: q ? mode : null, status: search.status, sort: search.sort, cursor: undefined },
          });
        }}
      >
        <div className="min-w-48 flex-1">
          <label className={labelCls} htmlFor="product-query">
            Find products
          </label>
          <Input
            id="product-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Title or SKU"
            maxLength={200}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="product-mode">
            Search by
          </label>
          <select
            id="product-mode"
            className={inputCls}
            value={mode}
            onChange={(event) => {
              if (isProductMode(event.target.value)) setMode(event.target.value);
            }}
          >
            <option value="title">Title</option>
            <option value="sku-exact">Exact SKU</option>
            <option value="sku-prefix">SKU starts with</option>
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="product-status">
            Status
          </label>
          <select
            id="product-status"
            className={inputCls}
            value={search.status}
            onChange={(event) => {
              if (isProductStatusFilter(event.target.value))
                void navigate({
                  search: { ...search, status: event.target.value, cursor: undefined },
                });
            }}
          >
            <option value="all">All products</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="product-sort">
            Sort by
          </label>
          <select
            id="product-sort"
            className={inputCls}
            value={search.sort}
            onChange={(event) => {
              if (isProductSort(event.target.value))
                void navigate({
                  search: { ...search, sort: event.target.value, cursor: undefined },
                });
            }}
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="title">Title A–Z</option>
            <option value="updated">Recently updated</option>
          </select>
        </div>
        <Button type="submit">Search</Button>
        <Button
          variant="outline"
          type="button"
          onClick={() => {
            setQuery('');
            void navigate({
              search: { q: '', mode: null, status: search.status, sort: search.sort, cursor: undefined },
            });
          }}
        >
          Browse all
        </Button>
        <p className="w-full text-xs text-zinc-500">
          SKU search is case-sensitive. Search runs when you press Search or Enter.
        </p>
      </form>
      <section className={`${cardCls} mt-6 overflow-hidden`}>
        {state === 'refine' ? (
          <p className="p-5 text-sm text-zinc-600" role="status">
            This search is too broad to display safely. Try a more specific title or SKU.
          </p>
        ) : products.length === 0 ? (
          <div className="p-5">
            <p className="text-sm text-zinc-500" role="status">
              {search.q
                ? 'No matching products. Try another title or SKU.'
                : 'No products yet. Create your first product below.'}
            </p>
            {search.cursor ? (
              <button
                className={`${btnSmall} mt-3`}
                onClick={() => void navigate({ search: { ...search, cursor: undefined } })}
              >
                Back to first page
              </button>
            ) : null}
            {search.q || search.status !== 'all' || search.sort !== 'newest' ? (
              <button
                className={`${btnSmall} mt-3 ml-2`}
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
          <div className={tableWrap} tabIndex={0} role="region" aria-label="Product results">
            <table className={`${tableCls} min-w-[680px]`}>
              <caption className="sr-only">Products</caption>
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Status</th>
                  <th scope="col">Price</th>
                  <th scope="col">Inventory</th>
                  <th scope="col" className="text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link
                        to="/admin/products/$id"
                        params={{ id: p.id }}
                        search={search}
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
                    </td>
                    <td>
                      <StatusBadge value={p.status} />
                    </td>
                    <td>
                      {p.price_cents != null
                        ? p.max_price_cents != null && p.max_price_cents !== p.price_cents
                          ? `${formatMoney(p.price_cents, currency)} – ${formatMoney(p.max_price_cents, currency)}`
                          : formatMoney(p.price_cents, currency)
                        : '-'}
                    </td>
                    <td>
                      {p.available <= 0 ? (
                        <span className="font-medium text-red-600">Out of stock</span>
                      ) : p.available <= 5 ? (
                        <span className="font-medium text-yellow-800">{p.available} left</span>
                      ) : (
                        `${p.available} in stock`
                      )}
                      <span className="block text-[13px] text-zinc-500">
                        {p.variant_count} {p.variant_count === 1 ? 'variant' : 'variants'}
                      </span>
                    </td>
                    <td className="text-right">
                      <span className="inline-flex flex-wrap justify-end gap-1">
                        <Link
                          to="/admin/products/$id"
                          params={{ id: p.id }}
                          search={search}
                          className={btnSmall}
                        >
                          Edit
                        </Link>
                        <button
                          className={btnGhost}
                          onClick={async () => {
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
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {previousCursor || nextCursor ? (
        <div className="mt-4 flex justify-between gap-3">
          {previousCursor ? (
            <button
              className={btnSmall}
              onClick={() => void navigate({ search: { ...search, cursor: previousCursor } })}
            >
              Previous 50 products
            </button>
          ) : (
            <span />
          )}
          {nextCursor ? (
            <button
              className={btnSmall}
              onClick={() => void navigate({ search: { ...search, cursor: nextCursor } })}
            >
              Next 50 products
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 grid items-start gap-5 lg:grid-cols-2">
        <form
          className={`${cardCls} space-y-4 p-5 sm:p-6`}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const r = await adminAction('product.create', {
              title: form.title,
              slug: form.slug || slugify(form.title),
              status: 'draft',
              description: '',
              variants: [
                {
                  sku: form.sku,
                  title: 'Default',
                  priceCents: Math.round(Number(form.price) * 100),
                  stock: Number(form.stock),
                },
              ],
            });
            setBusy(false);
            if (r.ok) {
              const data = r.data as { productId?: string } | undefined;
              setMsg({ kind: 'status', message: 'Product created as a draft.' });
              if (data?.productId)
                router.navigate({ to: '/admin/products/$id', params: { id: data.productId } });
              else router.invalidate();
            } else setMsg({ kind: 'error', message: r.error ?? 'Failed' });
          }}
        >
          <h2 className="text-sm font-medium text-zinc-950">Add product</h2>
          <div>
            <label className={labelCls} htmlFor="p-title">
              Title
            </label>
            <input
              id="p-title"
              placeholder="e.g. Everyday Tote"
              className={inputCls}
              value={form.title}
              onChange={(e) =>
                setForm({
                  ...form,
                  title: e.target.value,
                  slug: form.slug || slugify(e.target.value),
                })
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="p-slug">
                Slug
              </label>
              <input
                id="p-slug"
                placeholder="everyday-tote"
                className={inputCls}
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="p-sku">
                SKU
              </label>
              <input
                id="p-sku"
                placeholder="TOTE-001"
                className={inputCls}
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="p-price">
                Price ($)
              </label>
              <input
                id="p-price"
                inputMode="decimal"
                className={inputCls}
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="p-stock">
                Stock
              </label>
              <input
                id="p-stock"
                inputMode="numeric"
                className={inputCls}
                value={form.stock}
                onChange={(e) => setForm({ ...form, stock: e.target.value })}
              />
            </div>
          </div>
          <p className={hintCls}>
            Created as a draft. You will land on the edit page to add a description, images, and
            variants before publishing.
          </p>
          <button type="submit" disabled={busy} className={btnPrimary}>
            {busy ? 'Creating…' : 'Add product'}
          </button>
        </form>

        <div className="space-y-5">
          <section className={`${cardCls} space-y-4 p-5 sm:p-6`}>
            <div>
              <h2 className="text-sm font-medium text-zinc-950">Adjust inventory</h2>
              <p className={hintCls}>
                Every adjustment is written to the stock ledger, so counts can always be audited.
                You can also adjust stock per variant on the product edit page.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls} htmlFor="a-sku">
                  SKU
                </label>
                <input
                  id="a-sku"
                  placeholder="TOTE-001"
                  className={inputCls}
                  value={adjust.sku}
                  onChange={(e) => setAdjust({ ...adjust, sku: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="a-delta">
                  Change (+/-)
                </label>
                <input
                  id="a-delta"
                  className={inputCls}
                  value={adjust.delta}
                  onChange={(e) => setAdjust({ ...adjust, delta: e.target.value })}
                />
              </div>
            </div>
            <button
              className={btnSmall}
              onClick={async () => {
                const r = await adminAction('stock.adjust', {
                  sku: adjust.sku,
                  delta: Number(adjust.delta),
                  reason: 'restock',
                });
                if (r.ok) {
                  setMsg({ kind: 'status', message: 'Stock adjusted.' });
                  router.invalidate();
                } else setMsg({ kind: 'error', message: r.error ?? 'Failed' });
              }}
            >
              Adjust stock
            </button>
          </section>

          <section className={`${cardCls} space-y-4 p-5 sm:p-6`}>
            <div>
              <h2 className="text-sm font-medium text-zinc-950">Import products</h2>
              <p className={hintCls}>
                CSV with columns: title, slug, sku, price_cents, stock. Bad rows are reported, good
                rows still import.
              </p>
            </div>
            <textarea
              aria-label="Products CSV"
              className={`${textareaCls} font-mono text-xs`}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={5}
            />
            <button
              className={btnSmall}
              onClick={async () => {
                const r = await adminAction('import.productsCsv', { csv });
                if (r.ok) {
                  setMsg({ kind: 'status', message: `Import finished: ${JSON.stringify(r.data)}` });
                  router.invalidate();
                } else setMsg({ kind: 'error', message: r.error ?? 'Import failed' });
              }}
            >
              Import CSV
            </button>
          </section>
        </div>
      </div>
    </main>
  );
}

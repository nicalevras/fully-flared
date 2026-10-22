import { useState } from 'react';
import { staffMiddleware } from '../../../server/staff-middleware';
import { useStoreCurrency } from '../../../lib/use-store-currency';
import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { adminProducts } from '../../../server/admin-lists';
import { pageInputSchema } from '../../../schemas/pagination';
import { validateServerInput } from '../../../server/function-boundary';
import { AdminPager } from '../../../components/AdminPager';
import { useAdminAction } from '../../../components/AdminNav';
import { formatMoney, slugify } from '../../../lib/format';
import { StatusBadge } from '../../../components/StatusBadge';
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
  .validator(validateServerInput(pageInputSchema))
  .handler(async ({ data }) => {
    const { env } = await import('cloudflare:workers');
    return adminProducts(env.DB, data);
  });

export const Route = createFileRoute('/admin/products/')({
  validateSearch: pageInputSchema,
  loaderDeps: ({ search }) => ({ page: search.page }),
  loader: async ({ deps }) => getData({ data: deps }),
  component: AdminProducts,
});

function AdminProducts() {
  const adminAction = useAdminAction();

  const currency = useStoreCurrency();
  const { products, total, page } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [form, setForm] = useState({ title: '', slug: '', sku: '', price: '29.99', stock: '10' });
  const [csv, setCsv] = useState('title,slug,sku,price_cents,stock\n');
  const [adjust, setAdjust] = useState({ sku: '', delta: '10' });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <main>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className={pageTitle}>Products</h1>
          <p className={pageSub}>
            {total} product{total === 1 ? '' : 's'} in your catalog
            {total > products.length ? `, showing ${products.length} on this page` : ''}. Click a
            product to edit it, its variants, stock, and images.
          </p>
        </div>
      </div>

      <AdminPager
        label="Products pagination"
        page={page}
        total={total}
        pageSize={100}
        onPage={(page) => {
          void navigate({ search: (prev) => ({ ...prev, page }) });
        }}
      />
      <section className={`${cardCls} mt-6 overflow-hidden`}>
        {products.length === 0 ? (
          <p className="p-5 text-sm text-zinc-500" role="status">
            No products yet. Create your first product below.
          </p>
        ) : (
          <div className={tableWrap}>
            <table className={tableCls}>
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
                        className="flex items-center gap-3"
                      >
                        {p.imageKey ? (
                          <img
                            src={`/media/${p.imageKey}`}
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
                        </span>
                      </Link>
                    </td>
                    <td>
                      <StatusBadge value={p.status} />
                    </td>
                    <td>{p.priceCents != null ? formatMoney(p.priceCents, currency) : '-'}</td>
                    <td>
                      {(p.available ?? 0) <= 0 ? (
                        <span className="font-medium text-red-600">Out of stock</span>
                      ) : (p.available ?? 0) <= 5 ? (
                        <span className="font-medium text-yellow-800">{p.available} left</span>
                      ) : (
                        `${p.available} in stock`
                      )}
                    </td>
                    <td className="text-right">
                      <span className="inline-flex flex-wrap justify-end gap-1">
                        <Link to="/admin/products/$id" params={{ id: p.id }} className={btnSmall}>
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
                              setMsg(`${p.title} is now ${next}.`);
                              router.invalidate();
                            } else setMsg(r.error ?? 'Failed');
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
              setMsg('Product created as a draft.');
              if (data?.productId)
                router.navigate({ to: '/admin/products/$id', params: { id: data.productId } });
              else router.invalidate();
            } else setMsg(r.error ?? 'Failed');
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
                  setMsg('Stock adjusted.');
                  router.invalidate();
                } else setMsg(r.error ?? 'Failed');
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
                  setMsg(`Import finished: ${JSON.stringify(r.data)}`);
                  router.invalidate();
                } else setMsg(r.error ?? 'Import failed');
              }}
            >
              Import CSV
            </button>
          </section>
        </div>
      </div>
      {msg ? (
        <p className="mt-4 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700" role="status">
          {msg}
        </p>
      ) : null}
    </main>
  );
}

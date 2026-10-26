import { useState } from 'react';
import { staffMiddleware } from '../../../server/staff-middleware';
import { useStoreCurrency } from '../../../lib/use-store-currency';
import { Link, createFileRoute, useRouter, type SearchSchemaInput } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { validateServerInput } from '../../../server/function-boundary';
import { normalizeProductSearch } from '../../../lib/product-search';
import { idString } from '../../../schemas/common';
import { useAdminAction, type AdminPayload } from '../../../components/AdminNav';
import { formatMoney } from '../../../lib/format';
import { uploadMedia } from '../../../lib/upload';
import { applyVariantEdits, type VariantEdits } from '../../../lib/variant-edits';
import {
  btnDestructive,
  btnPrimary,
  btnSecondary,
  btnSmall,
  cardCls,
  hintCls,
  inputCls,
  labelCls,
  pageSub,
  pageTitle,
  textareaCls,
} from '../../../components/ui';

type VariantRow = {
  id: string;
  sku: string;
  title: string;
  price_cents: number;
  compare_at_cents: number | null;
  status: string;
  weight_grams: number | null;
  continue_selling: number;
  on_hand: number;
  reserved: number;
};
type MediaRow = { media_id: string; r2_key: string; position: number };
type Detail = {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: string;
  seo_title: string | null;
  seo_description: string | null;
  tax_code: string | null;
  variants: VariantRow[];
  media: MediaRow[];
  collections: Array<{ id: string; title: string }>;
  allCollections: Array<{ id: string; title: string }>;
};

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(idString))
  .handler(async ({ data: productId }): Promise<Detail | null> => {
    const { env } = await import('cloudflare:workers');
    const db = env.DB;
    const product = await db
      .prepare(
        'SELECT id, slug, title, description, status, seo_title, seo_description, tax_code FROM products WHERE id = ?'
      )
      .bind(productId)
      .first<Omit<Detail, 'variants' | 'media' | 'collections' | 'allCollections'>>();
    if (!product) return null;
    const [variants, media, cols, allCols] = await Promise.all([
      db
        .prepare(
          `SELECT v.id, v.sku, v.title, v.price_cents, v.compare_at_cents, v.status, v.weight_grams, v.continue_selling,
                COALESCE(s.on_hand, 0) AS on_hand, COALESCE(s.reserved, 0) AS reserved
         FROM variants v LEFT JOIN stock s ON s.sku = v.sku WHERE v.product_id = ? ORDER BY v.created_at`
        )
        .bind(productId)
        .all<VariantRow>(),
      db
        .prepare(
          `SELECT pm.media_id, m.r2_key, pm.position FROM product_media pm JOIN media m ON m.id = pm.media_id
         WHERE pm.product_id = ? ORDER BY pm.position`
        )
        .bind(productId)
        .all<MediaRow>(),
      db
        .prepare(
          'SELECT c.id, c.title FROM collections c JOIN product_collections pc ON pc.collection_id = c.id WHERE pc.product_id = ? ORDER BY c.title'
        )
        .bind(productId)
        .all<{ id: string; title: string }>(),
      db
        .prepare('SELECT id, title FROM collections ORDER BY title')
        .all<{ id: string; title: string }>(),
    ]);
    return {
      ...product,
      variants: variants.results,
      media: media.results,
      collections: cols.results,
      allCollections: allCols.results,
    };
  });

export const Route = createFileRoute('/admin/products/$id')({
  validateSearch: (search: { q?: unknown; mode?: unknown; cursor?: unknown } & SearchSchemaInput) =>
    normalizeProductSearch(search),
  loader: async ({ params }) => getData({ data: params.id }),
  component: EditProduct,
});

function EditProduct() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const router = useRouter();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  if (!data) {
    return (
      <main>
        <h1 className={pageTitle}>Product not found</h1>
        <p className={pageSub}>This product does not exist.</p>
        <Link to="/admin/products" search={search} className={`${btnSecondary} mt-5`}>
          Back to products
        </Link>
      </main>
    );
  }

  const product = data;
  return (
    <EditForm
      key={product.id}
      product={product}
      msg={msg}
      setMsg={setMsg}
      busy={busy}
      setBusy={setBusy}
      refresh={() => router.invalidate()}
    />
  );
}

function EditForm({
  product,
  msg,
  setMsg,
  busy,
  setBusy,
  refresh,
}: {
  product: Detail;
  msg: string;
  setMsg: (s: string) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const adminAction = useAdminAction();
  const currency = useStoreCurrency();
  const [form, setForm] = useState({
    title: product.title,
    slug: product.slug,
    description: product.description,
    taxCode: product.tax_code ?? '',
    status: product.status,
    seoTitle: product.seo_title ?? '',
    seoDescription: product.seo_description ?? '',
  });
  const [edits, setEdits] = useState<VariantEdits<VariantRow>>({});
  const variants = applyVariantEdits(product.variants, edits);
  const editVariant = (id: string, patch: Partial<VariantRow>) =>
    setEdits((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  const discardEdits = (ids: readonly string[]) =>
    setEdits((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id)))
    );
  const [selectedVariants, setSelectedVariants] = useState<string[]>([]);
  const [bulk, setBulk] = useState({ price: '', stockDelta: '' });
  const [newVariant, setNewVariant] = useState({ sku: '', title: '', price: '29.99' });
  const [stockDelta, setStockDelta] = useState<Record<string, string>>({});
  const [collectionIds, setCollectionIds] = useState<string[]>(
    product.collections.map((c) => c.id)
  );
  const [uploading, setUploading] = useState(false);

  const search = Route.useSearch();

  async function act(action: string, payload: AdminPayload, okMsg: string) {
    setBusy(true);
    const r = await adminAction(action, payload);
    setBusy(false);
    if (r.ok) {
      setMsg(okMsg);
      await refresh();
      return true;
    }
    setMsg(r.error ?? 'Failed');
    return false;
  }

  return (
    <main>
      <Link
        to="/admin/products"
        search={search}
        className="text-[13px] font-medium text-zinc-500 hover:text-zinc-950"
      >
        ← Products
      </Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className={pageTitle}>{product.title}</h1>
          <p className={pageSub}>
            /{product.slug} · {product.status}
          </p>
        </div>
        <span className="flex gap-2">
          <Link to="/products/$slug" params={{ slug: product.slug }} className={btnSmall}>
            View in store
          </Link>
          <button
            className={btnSecondary}
            disabled={busy}
            onClick={() =>
              act(
                'product.updateStatus',
                { productId: product.id, status: product.status === 'active' ? 'draft' : 'active' },
                product.status === 'active' ? 'Moved to draft.' : 'Published.'
              )
            }
          >
            {product.status === 'active' ? 'Move to draft' : 'Publish'}
          </button>
        </span>
      </div>

      {/* Details */}
      <form
        className={`${cardCls} mt-6 space-y-4 p-5 sm:p-6`}
        onSubmit={async (e) => {
          e.preventDefault();
          await act('product.update', { productId: product.id, ...form }, 'Product saved.');
        }}
      >
        <h2 className="text-sm font-medium text-zinc-950">Details</h2>
        <div>
          <label className={labelCls} htmlFor="e-tax-code">
            Stripe product tax code
          </label>
          <input
            id="e-tax-code"
            className={inputCls}
            placeholder="txcd_…"
            value={form.taxCode}
            onChange={(e) => setForm({ ...form, taxCode: e.target.value })}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="e-title">
            Title
          </label>
          <input
            id="e-title"
            className={inputCls}
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="e-slug">
              Slug
            </label>
            <input
              id="e-slug"
              className={inputCls}
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
            />
            <p className={hintCls}>Changing the slug changes the product URL.</p>
          </div>
          <div>
            <label className={labelCls} htmlFor="e-status">
              Status
            </label>
            <select
              id="e-status"
              className={inputCls}
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              <option value="draft">Draft</option>
              <option value="active">Active</option>
            </select>
          </div>
        </div>
        <div>
          <label className={labelCls} htmlFor="e-desc">
            Description
          </label>
          <textarea
            id="e-desc"
            className={textareaCls}
            rows={5}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="e-seo-title">
              SEO title
            </label>
            <input
              id="e-seo-title"
              className={inputCls}
              value={form.seoTitle}
              onChange={(e) => setForm({ ...form, seoTitle: e.target.value })}
              placeholder="Defaults to the product title"
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="e-seo-desc">
              SEO description
            </label>
            <input
              id="e-seo-desc"
              className={inputCls}
              value={form.seoDescription}
              onChange={(e) => setForm({ ...form, seoDescription: e.target.value })}
              placeholder="Defaults to the description"
            />
          </div>
        </div>
        <button type="submit" disabled={busy} className={btnPrimary}>
          {busy ? 'Saving…' : 'Save product'}
        </button>
      </form>

      {/* Images */}
      <section className={`${cardCls} mt-5 p-5 sm:p-6`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-zinc-950">Images</h2>
            <p className={hintCls}>
              The first image is the cover shown in listings. JPG, PNG, WebP, or GIF.
            </p>
          </div>
          <label className={`${btnSmall} cursor-pointer`}>
            {uploading ? 'Uploading…' : 'Add image'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="sr-only"
              aria-label="Add product image"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                setUploading(true);
                try {
                  const d = await uploadMedia(file);
                  await act(
                    'product.attachMedia',
                    { productId: product.id, mediaId: d.id },
                    'Image added.'
                  );
                } catch (err) {
                  setMsg(err instanceof Error ? err.message : 'Image upload failed');
                } finally {
                  setUploading(false);
                }
              }}
            />
          </label>
        </div>
        {product.media.length === 0 ? (
          <p
            className="mt-4 rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500"
            role="status"
          >
            No images yet. The storefront shows a letter tile until you add one.
          </p>
        ) : (
          <ul className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {product.media.map((m, i) => (
              <li key={m.media_id} className="group relative">
                <img
                  src={`/media/${m.r2_key}`}
                  alt={i === 0 ? `${product.title} cover image` : `${product.title} image ${i + 1}`}
                  className="aspect-square w-full rounded-xl object-cover"
                />
                {i === 0 ? (
                  <span className="absolute top-2 left-2 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-950 shadow-sm">
                    Cover
                  </span>
                ) : null}
                <button
                  className="absolute top-2 right-2 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-red-600 shadow-sm opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label={`Remove image ${i + 1}`}
                  onClick={() =>
                    act(
                      'product.detachMedia',
                      { productId: product.id, mediaId: m.media_id },
                      'Image removed.'
                    )
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Variants + stock */}
      <section className={`${cardCls} mt-5 p-5 sm:p-6`}>
        <h2 className="text-sm font-medium text-zinc-950">Variants and inventory</h2>
        <p className={hintCls}>
          Price and compare-at price are in dollars here and stored as cents. Stock changes go
          through the ledger.
        </p>
        {variants.length > 1 ? (
          <div className="mt-4 flex flex-wrap items-end gap-2 rounded-xl bg-zinc-50 p-3.5">
            <span className="text-[13px] font-medium text-zinc-950">
              Bulk edit{selectedVariants.length ? ` (${selectedVariants.length} selected)` : ''}
            </span>
            <span>
              <label className="sr-only" htmlFor="bulk-price">
                Bulk price in dollars
              </label>
              <input
                id="bulk-price"
                inputMode="decimal"
                placeholder="Set price $"
                className={`${inputCls} w-32`}
                value={bulk.price}
                onChange={(e) => setBulk({ ...bulk, price: e.target.value })}
              />
            </span>
            <span>
              <label className="sr-only" htmlFor="bulk-stock">
                Bulk stock change
              </label>
              <input
                id="bulk-stock"
                placeholder="Stock +10"
                className={`${inputCls} w-28`}
                value={bulk.stockDelta}
                onChange={(e) => setBulk({ ...bulk, stockDelta: e.target.value })}
              />
            </span>
            <button
              className={btnSmall}
              disabled={busy || selectedVariants.length === 0 || (!bulk.price && !bulk.stockDelta)}
              onClick={async () => {
                const ok = await act(
                  'variant.bulkUpdate',
                  {
                    variantIds: selectedVariants,
                    priceCents: bulk.price ? Math.round(Number(bulk.price) * 100) : null,
                    stockDelta: bulk.stockDelta ? Number(bulk.stockDelta) : 0,
                  },
                  `Bulk update applied to ${selectedVariants.length} variant${selectedVariants.length === 1 ? '' : 's'}.`
                );
                if (ok) {
                  discardEdits(selectedVariants);
                  setSelectedVariants([]);
                  setBulk({ price: '', stockDelta: '' });
                }
              }}
            >
              Apply to selected
            </button>
            <button
              className={btnSmall}
              onClick={() =>
                setSelectedVariants(
                  selectedVariants.length === variants.length ? [] : variants.map((v) => v.id)
                )
              }
            >
              {selectedVariants.length === variants.length ? 'Clear selection' : 'Select all'}
            </button>
          </div>
        ) : null}
        <div className="mt-4 space-y-3">
          {variants.map((v, vi) => {
            const available = v.on_hand - v.reserved;
            return (
              <div key={v.id} className="rounded-xl border border-zinc-200 p-4">
                {variants.length > 1 ? (
                  <label className="mb-3 flex items-center gap-2 text-[13px] text-zinc-500">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-zinc-950"
                      checked={selectedVariants.includes(v.id)}
                      onChange={(e) =>
                        setSelectedVariants(
                          e.target.checked
                            ? [...selectedVariants, v.id]
                            : selectedVariants.filter((x) => x !== v.id)
                        )
                      }
                    />
                    Select for bulk edit
                  </label>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] sm:items-end">
                  <div>
                    <label className={labelCls} htmlFor={`v-sku-${v.id}`}>
                      SKU
                    </label>
                    <input
                      id={`v-sku-${v.id}`}
                      className={inputCls}
                      value={v.sku}
                      onChange={(e) => editVariant(v.id, { sku: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor={`v-title-${v.id}`}>
                      Option name
                    </label>
                    <input
                      id={`v-title-${v.id}`}
                      className={inputCls}
                      value={v.title}
                      onChange={(e) => editVariant(v.id, { title: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor={`v-price-${v.id}`}>
                      Price ($)
                    </label>
                    <input
                      id={`v-price-${v.id}`}
                      inputMode="decimal"
                      className={inputCls}
                      value={(v.price_cents / 100).toString()}
                      onChange={(e) =>
                        editVariant(v.id, {
                          price_cents: Math.round(Number(e.target.value || 0) * 100),
                        })
                      }
                    />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor={`v-compare-${v.id}`}>
                      Compare at ($)
                    </label>
                    <input
                      id={`v-compare-${v.id}`}
                      inputMode="decimal"
                      className={inputCls}
                      value={
                        v.compare_at_cents != null ? (v.compare_at_cents / 100).toString() : ''
                      }
                      placeholder="Optional"
                      onChange={(e) =>
                        editVariant(v.id, {
                          compare_at_cents:
                            e.target.value === '' ? null : Math.round(Number(e.target.value) * 100),
                        })
                      }
                    />
                  </div>
                  <button
                    className={btnSmall}
                    disabled={busy}
                    onClick={async () => {
                      const cur = variants[vi];
                      if (!cur) return;
                      const saved = await act(
                        'variant.save',
                        {
                          variantId: cur.id,
                          productId: product.id,
                          sku: cur.sku,
                          title: cur.title,
                          priceCents: cur.price_cents,
                          compareAtCents: cur.compare_at_cents,
                          weightGrams: cur.weight_grams,
                          continueSelling: Boolean(cur.continue_selling),
                        },
                        `Variant ${cur.sku} saved.`
                      );
                      if (saved) discardEdits([cur.id]);
                    }}
                  >
                    Save
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                  <label className={labelCls}>
                    Weight (g)
                    <input
                      aria-label={`Weight for ${v.sku}`}
                      type="number"
                      min="0"
                      className={inputCls}
                      value={v.weight_grams ?? ''}
                      onChange={(e) =>
                        editVariant(v.id, {
                          weight_grams: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={Boolean(v.continue_selling)}
                      onChange={(e) =>
                        editVariant(v.id, { continue_selling: e.target.checked ? 1 : 0 })
                      }
                    />
                    Continue selling when out of stock
                  </label>
                  <span
                    className={
                      available <= 0
                        ? 'font-medium text-red-600'
                        : available <= 5
                          ? 'font-medium text-yellow-800'
                          : 'text-zinc-600'
                    }
                  >
                    {v.on_hand} on hand · {v.reserved} reserved · {available} available (
                    {formatMoney(v.price_cents, currency)})
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    <label className="sr-only" htmlFor={`v-stock-${v.id}`}>
                      Stock change for {v.sku}
                    </label>
                    <input
                      id={`v-stock-${v.id}`}
                      className={`${inputCls} w-24`}
                      placeholder="+10"
                      value={stockDelta[v.id] ?? ''}
                      onChange={(e) => setStockDelta({ ...stockDelta, [v.id]: e.target.value })}
                    />
                    <button
                      className={btnSmall}
                      disabled={busy || !stockDelta[v.id]}
                      onClick={async () => {
                        if (
                          await act(
                            'stock.adjust',
                            { sku: v.sku, delta: Number(stockDelta[v.id]), reason: 'restock' },
                            `Stock adjusted for ${v.sku}.`
                          )
                        ) {
                          setStockDelta({ ...stockDelta, [v.id]: '' });
                        }
                      }}
                    >
                      Adjust stock
                    </button>
                    <button
                      className={btnDestructive}
                      disabled={busy || variants.length <= 1}
                      onClick={async () => {
                        if (!window.confirm(`Delete variant ${v.sku}? This cannot be undone.`))
                          return;
                        await act(
                          'variant.delete',
                          { variantId: v.id },
                          `Variant ${v.sku} deleted.`
                        );
                      }}
                    >
                      Delete
                    </button>
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <form
          className="mt-4 grid gap-3 rounded-xl bg-zinc-50 p-4 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await act(
              'variant.save',
              {
                productId: product.id,
                sku: newVariant.sku,
                title: newVariant.title || 'Default',
                priceCents: Math.round(Number(newVariant.price) * 100),
                compareAtCents: null,
              },
              `Variant ${newVariant.sku} added with 0 stock. Adjust stock above to sell it.`
            );
            if (ok) setNewVariant({ sku: '', title: '', price: '29.99' });
          }}
        >
          <div>
            <label className={labelCls} htmlFor="nv-sku">
              New SKU
            </label>
            <input
              id="nv-sku"
              className={inputCls}
              placeholder="TOTE-002"
              value={newVariant.sku}
              onChange={(e) => setNewVariant({ ...newVariant, sku: e.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="nv-title">
              Option name
            </label>
            <input
              id="nv-title"
              className={inputCls}
              placeholder="Large"
              value={newVariant.title}
              onChange={(e) => setNewVariant({ ...newVariant, title: e.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="nv-price">
              Price ($)
            </label>
            <input
              id="nv-price"
              inputMode="decimal"
              className={inputCls}
              value={newVariant.price}
              onChange={(e) => setNewVariant({ ...newVariant, price: e.target.value })}
            />
          </div>
          <button type="submit" disabled={busy || !newVariant.sku} className={btnSecondary}>
            Add variant
          </button>
        </form>
      </section>

      {/* Collections */}
      <section className={`${cardCls} mt-5 p-5 sm:p-6`}>
        <h2 className="text-sm font-medium text-zinc-950">Collections</h2>
        {product.allCollections.length === 0 ? (
          <p className={hintCls}>No collections exist yet. Create one in Admin → Collections.</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {product.allCollections.map((c) => {
              const on = collectionIds.includes(c.id);
              return (
                <button
                  key={c.id}
                  aria-pressed={on}
                  disabled={busy}
                  className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${on ? 'bg-zinc-950 text-white' : 'border border-zinc-300 text-zinc-700 hover:border-zinc-950'}`}
                  onClick={async () => {
                    const next = !on;
                    if (
                      await act(
                        'collection.toggleProduct',
                        { collectionId: c.id, productId: product.id, included: next },
                        next ? `Added to ${c.title}.` : `Removed from ${c.title}.`
                      )
                    ) {
                      setCollectionIds(
                        next ? [...collectionIds, c.id] : collectionIds.filter((x) => x !== c.id)
                      );
                    }
                  }}
                >
                  {c.title}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {msg ? (
        <p className="mt-4 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700" role="status">
          {msg}
        </p>
      ) : null}
    </main>
  );
}

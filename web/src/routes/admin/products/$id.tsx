import { useEffect, useState } from 'react';
import { staffMiddleware } from '../../../server/staff-middleware';
import { useStoreCurrency } from '../../../lib/use-store-currency';
import {
  Link,
  createFileRoute,
  useBlocker,
  useRouter,
  type SearchSchemaInput,
} from '@tanstack/react-router';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { createServerFn } from '@tanstack/react-start';
import { validateServerInput } from '../../../server/function-boundary';
import { normalizeProductSearch } from '../../../lib/product-search';
import { idString } from '../../../schemas/common';
import { useAdminAction, type AdminPayload } from '../../../components/AdminNav';
import { formatMoney } from '../../../lib/format';
import { uploadMedia } from '../../../lib/upload';
import { applyVariantEdits, type VariantEdits } from '../../../lib/variant-edits';
import { BlogEditor } from '../../../components/BlogEditor';
import { buildBulkPriceReview } from '../../../lib/variant-bulk-review';
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
type MediaRow = { media_id: string; r2_key: string; position: number; alt_text: string };
type LibraryMediaRow = { id: string; r2_key: string; alt_text: string };
type Detail = {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: string;
  seo_title: string | null;
  seo_description: string | null;
  tax_code: string | null;
  description_html: string | null;
  revision: number | null;
  processed_revision: number | null;
  variants: VariantRow[];
  media: MediaRow[];
  collections: Array<{ id: string; title: string }>;
  allCollections: Array<{ id: string; title: string }>;
  allMedia: LibraryMediaRow[];
};

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(idString))
  .handler(async ({ data: productId }): Promise<Detail | null> => {
    const { env } = await import('cloudflare:workers');
    const db = env.DB;
    const product = await db
      .prepare(
        "SELECT id, slug, title, description, status, seo_title, seo_description, tax_code, (SELECT target_revision FROM catalog_work WHERE entity_type = 'product' AND entity_id = products.id) AS revision, (SELECT processed_revision FROM catalog_work WHERE entity_type = 'product' AND entity_id = products.id) AS processed_revision FROM products WHERE id = ?"
      )
      .bind(productId)
      .first<Omit<Detail, 'variants' | 'media' | 'collections' | 'allCollections' | 'allMedia'>>();
    if (!product) return null;
    const [variants, media, cols, allCols, allMedia] = await Promise.all([
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
          `SELECT pm.media_id, m.r2_key, pm.position, m.alt_text FROM product_media pm JOIN media m ON m.id = pm.media_id
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
      db
        .prepare(
          'SELECT id, r2_key, alt_text FROM media WHERE ready = 1 AND deletion_pending = 0 ORDER BY created_at DESC LIMIT 60'
        )
        .all<LibraryMediaRow>(),
    ]);
    return {
      ...product,
      variants: variants.results,
      media: media.results,
      collections: cols.results,
      allCollections: allCols.results,
      allMedia: allMedia.results,
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
  const initialForm = {
    title: product.title,
    slug: product.slug,
    description: product.description,
    descriptionHtml: product.description_html ?? '',
    taxCode: product.tax_code ?? '',
    status: product.status,
    seoTitle: product.seo_title ?? '',
    seoDescription: product.seo_description ?? '',
  };
  const [form, setForm] = useState(initialForm);
  const [conflict, setConflict] = useState(false);
  const [richMode, setRichMode] = useState(Boolean(product.description_html));
  const [reviewOpen, setReviewOpen] = useState(false);
  const fieldLabels: Record<string, string> = {
    title: 'Title',
    slug: 'Slug',
    description: 'Description',
    descriptionHtml: 'Rich description',
    taxCode: 'Tax code',
    status: 'Status',
    seoTitle: 'SEO title',
    seoDescription: 'SEO description',
  };
  const changedFields = Object.keys(fieldLabels).filter(
    (key) => form[key as keyof typeof form] !== initialForm[key as keyof typeof initialForm]
  );
  const dirty = changedFields.length > 0;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const [edits, setEdits] = useState<VariantEdits<VariantRow>>({});
  const blocker = useBlocker({
    shouldBlockFn: () => dirty || Object.keys(edits).length > 0,
    enableBeforeUnload: false,
    withResolver: true,
  });
  const variants = applyVariantEdits(product.variants, edits);
  const editVariant = (id: string, patch: Partial<VariantRow>) =>
    setEdits((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  const discardEdits = (ids: readonly string[]) =>
    setEdits((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id)))
    );
  const [selectedVariants, setSelectedVariants] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    action: () => void | Promise<void>;
  } | null>(null);

  const [bulk, setBulk] = useState({ price: '' });
  const [bulkReviewOpen, setBulkReviewOpen] = useState(false);
  const [newVariant, setNewVariant] = useState({ sku: '', title: '', price: '29.99' });
  const [stockDelta, setStockDelta] = useState<Record<string, string>>({});
  const [collectionIds, setCollectionIds] = useState<string[]>(
    product.collections.map((c) => c.id)
  );
  const [uploading, setUploading] = useState(false);
  const [altDrafts, setAltDrafts] = useState<Record<string, string>>({});

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
        id="product-details-form"
        className={`${cardCls} mt-6 space-y-4 p-5 sm:p-6`}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const r = await adminAction('product.update', {
            productId: product.id,
            ...form,
            ...(product.revision !== null ? { expectedRevision: product.revision } : {}),
          });
          setBusy(false);
          if (r.ok) {
            setConflict(false);
            setReviewOpen(false);
            setMsg('Saved; publication pending.');
            await refresh();
          } else {
            setConflict(Boolean((r as { conflict?: boolean }).conflict));
            setMsg(r.error ?? 'Failed');
          }
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className={labelCls} htmlFor="e-desc">
              Description
            </label>
            <button
              type="button"
              className={btnSmall}
              onClick={() => {
                if (!richMode && !form.descriptionHtml && form.description) {
                  setForm({
                    ...form,
                    descriptionHtml: form.description
                      .split(/\n{2,}/)
                      .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
                      .join(''),
                  });
                }
                if (richMode) setForm({ ...form, descriptionHtml: '' });
                setRichMode(!richMode);
              }}
            >
              {richMode ? 'Use plain text instead' : 'Use rich text'}
            </button>
          </div>
          {richMode ? (
            <div className="mt-1">
              <BlogEditor
                key={product.id}
                initialHtml={form.descriptionHtml || '<p></p>'}
                onSave={async () => {}}
                onChange={(html) => setForm((current) => ({ ...current, descriptionHtml: html }))}
              />
              <p className={hintCls}>
                Rich text is sanitized on save. Shoppers see the formatted version. Search uses a
                plain text version derived from it.
              </p>
            </div>
          ) : (
            <textarea
              id="e-desc"
              className={textareaCls}
              rows={5}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          )}
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
        <p className={hintCls}>
          {product.revision !== null && (product.processed_revision ?? 0) < product.revision
            ? 'Publication pending for the latest saved revision.'
            : 'All saved changes have been published from the latest known revision.'}
        </p>
      </form>

      <ConfirmDialog
        request={
          blocker.status === 'blocked'
            ? {
                title: 'Leave with unsaved changes?',
                body: 'This product has unsaved changes. Leaving now discards them.',
                confirmLabel: 'Leave and discard',
              }
            : null
        }
        busy={false}
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
      {dirty ? (
        <div
          className="fixed inset-x-3 bottom-3 z-40 mx-auto max-w-2xl rounded-2xl border border-zinc-200 bg-white p-3 shadow-lg sm:inset-x-6"
          role="region"
          aria-label="Unsaved product changes"
        >
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-zinc-950">
              {changedFields.length} unsaved change{changedFields.length === 1 ? '' : 's'}
            </p>
            <span className="flex-1" />
            <button type="button" className={btnSmall} onClick={() => setReviewOpen(!reviewOpen)}>
              {reviewOpen ? 'Hide review' : 'Review'}
            </button>
            <button
              type="button"
              className={btnSmall}
              onClick={() => {
                setForm(initialForm);
                setReviewOpen(false);
              }}
            >
              Discard
            </button>
            <button
              type="submit"
              form="product-details-form"
              disabled={busy}
              className={btnPrimary}
            >
              {busy
                ? 'Saving...'
                : form.status !== product.status
                  ? form.status === 'active'
                    ? 'Save and publish'
                    : 'Save and move to draft'
                  : 'Save changes'}
            </button>
          </div>
          {reviewOpen ? (
            <ul className="mt-2 list-disc pl-5 text-sm text-zinc-600">
              {changedFields.map((key) => (
                <li key={key}>{fieldLabels[key]} changed</li>
              ))}
            </ul>
          ) : null}
          {conflict ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-sm text-red-700" role="alert">
                The saved version changed. Your edits are still here.
              </p>
              <button type="button" className={btnSmall} onClick={() => void refresh()}>
                Reload current version
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

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
          <>
            <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {product.media.map((m, i) => (
                <li key={m.media_id} className="rounded-xl border border-zinc-200 p-2">
                  <div className="relative">
                    <img
                      src={`/media/${m.r2_key}`}
                      alt={m.alt_text || `${product.title} image ${i + 1}`}
                      className="aspect-square w-full rounded-lg object-cover"
                    />
                    {i === 0 ? (
                      <span className="absolute top-2 left-2 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-950 shadow-sm">
                        Cover
                      </span>
                    ) : null}
                  </div>
                  <label className={labelCls} htmlFor={`alt-${m.media_id}`}>
                    Alt text
                  </label>
                  <input
                    id={`alt-${m.media_id}`}
                    className={inputCls}
                    value={altDrafts[m.media_id] ?? m.alt_text}
                    onChange={(e) => setAltDrafts({ ...altDrafts, [m.media_id]: e.target.value })}
                  />
                  <div className="mt-2 flex flex-wrap gap-1">
                    <button
                      type="button"
                      className={btnSmall}
                      disabled={(altDrafts[m.media_id] ?? m.alt_text) === m.alt_text}
                      onClick={() =>
                        act(
                          'media.updateAlt',
                          { mediaId: m.media_id, altText: altDrafts[m.media_id] ?? m.alt_text },
                          'Alt text saved. This image is shared, so the new text applies everywhere it is used.'
                        )
                      }
                    >
                      Save alt
                    </button>
                    {i > 0 ? (
                      <button
                        type="button"
                        className={btnSmall}
                        onClick={() => {
                          const ids = product.media.map((row) => row.media_id);
                          const next = [m.media_id, ...ids.filter((id) => id !== m.media_id)];
                          void act(
                            'product.reorderMedia',
                            { productId: product.id, mediaIds: next, expectedMediaIds: ids },
                            'Cover image updated.'
                          );
                        }}
                      >
                        Make cover
                      </button>
                    ) : null}
                    {i > 0 ? (
                      <button
                        type="button"
                        className={btnSmall}
                        aria-label={`Move image ${i + 1} earlier`}
                        onClick={() => {
                          const ids = product.media.map((row) => row.media_id);
                          const next = [...ids];
                          const held = next[i - 1];
                          const current = next[i];
                          if (held !== undefined && current !== undefined) {
                            next[i - 1] = current;
                            next[i] = held;
                          }
                          void act(
                            'product.reorderMedia',
                            { productId: product.id, mediaIds: next, expectedMediaIds: ids },
                            'Image order updated.'
                          );
                        }}
                      >
                        Earlier
                      </button>
                    ) : null}
                    {i < product.media.length - 1 ? (
                      <button
                        type="button"
                        className={btnSmall}
                        aria-label={`Move image ${i + 1} later`}
                        onClick={() => {
                          const ids = product.media.map((row) => row.media_id);
                          const next = [...ids];
                          const held = next[i];
                          const following = next[i + 1];
                          if (held !== undefined && following !== undefined) {
                            next[i] = following;
                            next[i + 1] = held;
                          }
                          void act(
                            'product.reorderMedia',
                            { productId: product.id, mediaIds: next, expectedMediaIds: ids },
                            'Image order updated.'
                          );
                        }}
                      >
                        Later
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={btnSmall}
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
                  </div>
                </li>
              ))}
            </ul>
            {(() => {
              const attached = new Set(product.media.map((row) => row.media_id));
              const available = product.allMedia.filter((row) => !attached.has(row.id));
              if (available.length === 0) return null;
              return (
                <div className="mt-5">
                  <h3 className="text-sm font-medium text-zinc-950">Add an existing image</h3>
                  <ul className="mt-2 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                    {available.map((row) => (
                      <li key={row.id} className="rounded-xl border border-zinc-200 p-2">
                        <img
                          src={`/media/${row.r2_key}`}
                          alt={row.alt_text || 'Library image'}
                          className="aspect-square w-full rounded-lg object-cover"
                        />
                        <button
                          type="button"
                          className={`${btnSmall} mt-2 w-full`}
                          onClick={() =>
                            act(
                              'product.attachMedia',
                              { productId: product.id, mediaId: row.id },
                              'Image added.'
                            )
                          }
                        >
                          Attach
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
          </>
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
            <button
              className={btnSmall}
              disabled={busy || selectedVariants.length === 0 || !bulk.price}
              onClick={() => setBulkReviewOpen(true)}
            >
              Review price changes
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
        {bulkReviewOpen ? (
          <div
            className="mt-4 rounded-xl border border-zinc-200 p-4"
            role="region"
            aria-label="Review bulk price changes"
          >
            {(() => {
              const review = buildBulkPriceReview(
                variants,
                selectedVariants,
                bulk.price ? Math.round(Number(bulk.price) * 100) : null
              );
              return (
                <>
                  <h3 className="text-sm font-medium text-zinc-950">Review price changes</h3>
                  {review.errors.length > 0 ? (
                    <p className="mt-1 text-sm text-red-700" role="alert">
                      {review.errors.join(' ')}
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-sm text-zinc-600">
                      {review.rows.map((row) => (
                        <li key={row.id}>
                          {row.sku} ({row.title}): {formatMoney(row.oldPriceCents, currency)} to{' '}
                          {formatMoney(row.newPriceCents, currency)}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-2 text-xs text-zinc-500">
                    One submission updates every listed variant together. If any variant fails, none
                    are changed. Stock is not changed here. Use the stock controls or Inventory so
                    every stock change goes through the ledger.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      className={btnPrimary}
                      disabled={busy || review.errors.length > 0}
                      onClick={async () => {
                        const ok = await act(
                          'variant.bulkUpdate',
                          {
                            variantIds: selectedVariants,
                            priceCents: bulk.price ? Math.round(Number(bulk.price) * 100) : null,
                            stockDelta: 0,
                          },
                          `Price updated for ${selectedVariants.length} variant${selectedVariants.length === 1 ? '' : 's'}.`
                        );
                        if (ok) {
                          discardEdits(selectedVariants);
                          setSelectedVariants([]);
                          setBulk({ price: '' });
                          setBulkReviewOpen(false);
                        }
                      }}
                    >
                      Apply price to {selectedVariants.length} selected
                    </button>
                    <button
                      type="button"
                      className={btnSmall}
                      onClick={() => setBulkReviewOpen(false)}
                    >
                      Back
                    </button>
                  </div>
                </>
              );
            })()}
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
                      Price ({currency})
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
                      Compare at ({currency})
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
                      onClick={() =>
                        setConfirm({
                          title: `Delete variant ${v.sku}?`,
                          body: 'This cannot be undone.',
                          confirmLabel: 'Delete variant',
                          action: async () => {
                            await act(
                              'variant.delete',
                              { variantId: v.id },
                              `Variant ${v.sku} deleted.`
                            );
                          },
                        })
                      }
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
              Price ({currency})
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
      <ConfirmDialog
        request={
          confirm
            ? { title: confirm.title, body: confirm.body, confirmLabel: confirm.confirmLabel }
            : null
        }
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const current = confirm;
          setConfirm(null);
          if (current) void current.action();
        }}
      />
    </main>
  );
}

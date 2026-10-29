import { useEffect, useState } from 'react';
import { createServerFn } from '@tanstack/react-start';
import { Link, useBlocker } from '@tanstack/react-router';
import { ConfirmDialog } from './ConfirmDialog';
import { SeoPreview } from './SeoPreview';
import { validateServerInput } from '../server/function-boundary';
import { staffMiddleware } from '../server/staff-middleware';
import { idString } from '../schemas/common';
import { useAdminAction, type AdminPayload } from './AdminNav';
import { AdminActionFeedback, type AdminActionFeedbackState } from './AdminActionFeedback';
import { useStoreCurrency } from '../lib/use-store-currency';
import { formatMoney } from '../lib/format';
import { uploadMedia } from '../lib/upload';
import { applyVariantEdits, type VariantEdits } from '../lib/variant-edits';
import { buildBulkPriceReview } from '../lib/variant-bulk-review';
import {
  btnDestructive,
  btnPrimary,
  btnSecondary,
  btnSmall,
  hintCls,
  inputCls,
  labelCls,
  textareaCls,
} from './ui';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import { Sortable, SortableItem } from './ui/sortable';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Checkbox } from './ui/checkbox';
import { ChevronDownIcon, EllipsisIcon, MinusIcon, PlusIcon, XIcon } from 'lucide-react';

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
export type ProductDetail = {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: string;
  seo_title: string | null;
  seo_description: string | null;
  revision: number | null;
  processed_revision: number | null;
  variants: VariantRow[];
  media: MediaRow[];
  collections: Array<{ id: string; title: string }>;
  allCollections: Array<{ id: string; title: string }>;
};

export const getProductDetail = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(idString))
  .handler(async ({ data: productId }): Promise<ProductDetail | null> => {
    const { env } = await import('cloudflare:workers');
    const db = env.DB;
    const product = await db
      .prepare(
        "SELECT id, slug, title, description, status, seo_title, seo_description, (SELECT target_revision FROM catalog_work WHERE entity_type = 'product' AND entity_id = products.id) AS revision, (SELECT processed_revision FROM catalog_work WHERE entity_type = 'product' AND entity_id = products.id) AS processed_revision FROM products WHERE id = ?"
      )
      .bind(productId)
      .first<Omit<ProductDetail, 'variants' | 'media' | 'collections' | 'allCollections'>>();
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
    ]);
    return {
      ...product,
      variants: variants.results,
      media: media.results,
      collections: cols.results,
      allCollections: allCols.results,
    };
  });

export function ProductEditor({
  product,
  open,
  onClose,
  refresh,
}: {
  product: ProductDetail;
  open: boolean;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [busy, setBusy] = useState(false);
  const [sheetMenuOpen, setSheetMenuOpen] = useState(false);
  const [closeDiscard, setCloseDiscard] = useState(false);

  useEffect(() => {
    if (!sheetMenuOpen) return;
    const close = () => setSheetMenuOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [sheetMenuOpen]);
  const adminAction = useAdminAction();
  const currency = useStoreCurrency();
  const initialForm = {
    title: product.title,
    slug: product.slug,
    description: product.description,
    status: product.status,
    seoTitle: product.seo_title ?? '',
    seoDescription: product.seo_description ?? '',
  };
  const [form, setForm] = useState(initialForm);
  const [conflict, setConflict] = useState(false);
  const [openSections, setOpenSections] = useState<string[]>(['details']);
  useEffect(() => {
    if (open) setOpenSections(['details']);
  }, [open, product.id]);
  const fieldLabels: Record<string, string> = {
    title: 'Title',
    slug: 'Slug',
    description: 'Description',
    status: 'Status',
    seoTitle: 'SEO title',
    seoDescription: 'SEO description',
  };
  const changedFields = Object.keys(fieldLabels).filter(
    (key) => form[key as keyof typeof form] !== initialForm[key as keyof typeof initialForm]
  );
  const [selectedVariants, setSelectedVariants] = useState<string[]>([]);

  const [bulk, setBulk] = useState({ price: '' });
  const [bulkReviewOpen, setBulkReviewOpen] = useState(false);
  const [newVariant, setNewVariant] = useState({ sku: '', title: '', price: '29.99' });
  const [stockDelta, setStockDelta] = useState<Record<string, string>>({});
  const [collectionIds, setCollectionIds] = useState<string[]>(
    product.collections.map((c) => c.id)
  );
  const [stagedNewVariants, setStagedNewVariants] = useState<
    Array<{ localId: string; sku: string; title: string; price: string }>
  >([]);
  const [deletedVariantIds, setDeletedVariantIds] = useState<string[]>([]);
  type MediaDraftEntry = {
    key: string;
    media_id: string | null;
    r2_key: string;
    src: string;
    alt_text: string;
    file: File | null;
  };
  const [mediaDraft, setMediaDraft] = useState<MediaDraftEntry[] | null>(null);
  const [selectedMediaKey, setSelectedMediaKey] = useState<string | null>(null);
  const persistedMedia: MediaDraftEntry[] = product.media.map((m) => ({
    key: m.media_id,
    media_id: m.media_id,
    r2_key: m.r2_key,
    src: `/media/${m.r2_key}`,
    alt_text: m.alt_text,
    file: null,
  }));
  const displayMedia = mediaDraft ?? persistedMedia;

  const detailsDirty = changedFields.length > 0;
  const [edits, setEdits] = useState<VariantEdits<VariantRow>>({});
  const variants = applyVariantEdits(product.variants, edits);
  const visibleVariants = variants.filter((v) => !deletedVariantIds.includes(v.id));
  const stockDirtyIds = Object.keys(stockDelta).filter((id) => {
    if (deletedVariantIds.includes(id)) return false;
    const staged = (stockDelta[id] ?? '').trim();
    if (staged === '') return false;
    const v = variants.find((x) => x.id === id);
    return v !== undefined && Number.isFinite(Number(staged)) && Number(staged) !== v.on_hand;
  });
  const variantsDirty =
    Object.keys(edits).some((id) => !deletedVariantIds.includes(id)) ||
    stagedNewVariants.length > 0 ||
    deletedVariantIds.length > 0 ||
    stockDirtyIds.length > 0;
  const persistedMediaIds = product.media.map((m) => m.media_id);
  const draftExistingIds = displayMedia
    .map((e) => e.media_id)
    .filter((id): id is string => id !== null);
  const mediaDirty =
    displayMedia.some((e) => e.file !== null) ||
    draftExistingIds.length !== persistedMediaIds.length ||
    draftExistingIds.some((id, i) => id !== persistedMediaIds[i]) ||
    displayMedia.some((e) => {
      if (!e.media_id) return false;
      const persisted = product.media.find((m) => m.media_id === e.media_id);
      return persisted ? persisted.alt_text !== e.alt_text : false;
    });
  const collectionsDirty =
    collectionIds.length !== product.collections.length ||
    collectionIds.some((id) => !product.collections.some((c) => c.id === id));
  const anyDirty = detailsDirty || variantsDirty || mediaDirty || collectionsDirty;
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [anyDirty]);
  const blocker = useBlocker({
    shouldBlockFn: () => anyDirty,
    enableBeforeUnload: false,
    withResolver: true,
  });
  const editVariant = (id: string, patch: Partial<VariantRow>) =>
    setEdits((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  const discardEdits = (ids: readonly string[]) =>
    setEdits((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id)))
    );

  async function runAction(action: string, payload: AdminPayload) {
    return adminAction(action, payload);
  }

  const revokeStaged = (draft: MediaDraftEntry[] | null) => {
    for (const e of draft ?? []) if (e.file) URL.revokeObjectURL(e.src);
  };

  const discardAndClose = () => {
    setCloseDiscard(false);
    revokeStaged(mediaDraft);
    setForm(initialForm);
    setEdits({});
    setStockDelta({});
    setStagedNewVariants([]);
    setDeletedVariantIds([]);
    setMediaDraft(null);
    setSelectedMediaKey(null);
    setCollectionIds(product.collections.map((c) => c.id));
    setSelectedVariants([]);
    setConflict(false);
    setTimeout(onClose, 0);
  };

  const requestClose = () => {
    if (anyDirty) {
      setCloseDiscard(true);
      return;
    }
    onClose();
  };

  async function saveAll() {
    if (!anyDirty || busy) return;
    setBusy(true);
    const failures: string[] = [];
    let anyOk = false;
    const fail = (group: string, error?: string) => {
      if (!failures.some((f) => f.startsWith(group)))
        failures.push(`${group} couldn't be saved \u2014 ${error ?? 'Failed'}`);
    };

    if (detailsDirty) {
      const r = await runAction('product.update', {
        productId: product.id,
        ...form,
        ...(product.revision !== null ? { expectedRevision: product.revision } : {}),
      });
      if (r.ok) {
        anyOk = true;
        setConflict(false);
      } else {
        setConflict(Boolean((r as { conflict?: boolean }).conflict));
        fail('Details', r.error);
      }
    }

    if (variantsDirty) {
      const failedVariantIds = new Set<string>();
      for (const v of visibleVariants) {
        if (!edits[v.id]) continue;
        const r = await runAction('variant.save', {
          variantId: v.id,
          productId: product.id,
          sku: v.sku,
          title: v.title,
          priceCents: v.price_cents,
          compareAtCents: v.compare_at_cents,
          weightGrams: v.weight_grams,
          continueSelling: Boolean(v.continue_selling),
        });
        if (r.ok) {
          anyOk = true;
          discardEdits([v.id]);
        } else {
          failedVariantIds.add(v.id);
          fail('Variants', r.error);
        }
      }
      let remainingNew = [...stagedNewVariants];
      for (const nv of stagedNewVariants) {
        const r = await runAction('variant.save', {
          productId: product.id,
          sku: nv.sku,
          title: nv.title || 'Default',
          priceCents: Math.round(Number(nv.price) * 100),
          compareAtCents: null,
        });
        if (r.ok) {
          anyOk = true;
          remainingNew = remainingNew.filter((x) => x.localId !== nv.localId);
          setStagedNewVariants(remainingNew);
        } else fail('Variants', r.error);
      }
      let remainingDeleted = [...deletedVariantIds];
      for (const id of deletedVariantIds) {
        const r = await runAction('variant.delete', { variantId: id });
        if (r.ok) {
          anyOk = true;
          remainingDeleted = remainingDeleted.filter((x) => x !== id);
          setDeletedVariantIds(remainingDeleted);
          discardEdits([id]);
        } else fail('Variants', r.error);
      }
      for (const id of stockDirtyIds) {
        if (failedVariantIds.has(id)) continue;
        const v = visibleVariants.find((x) => x.id === id);
        if (!v) continue;
        const r = await runAction('stock.adjust', {
          sku: v.sku,
          delta: Number(stockDelta[id]) - v.on_hand,
          reason: 'restock',
        });
        if (r.ok) {
          anyOk = true;
          setStockDelta((cur) => {
            const n = { ...cur };
            delete n[id];
            return n;
          });
        } else fail('Stock', r.error);
      }
    }

    let mediaOk = !mediaDirty;
    if (mediaDirty) {
      const draft: MediaDraftEntry[] = [...displayMedia];
      let groupFailed = false;
      const attachedNewIds: string[] = [];
      for (const entry of draft) {
        if (!entry.file) continue;
        try {
          const d = await uploadMedia(entry.file, entry.alt_text);
          const r = await runAction('product.attachMedia', {
            productId: product.id,
            mediaId: d.id,
          });
          if (!r.ok) {
            groupFailed = true;
            fail('Images', r.error);
            break;
          }
          entry.media_id = d.id;
          entry.r2_key = d.key;
          entry.src = `/media/${d.key}`;
          entry.file = null;
          attachedNewIds.push(d.id);
          anyOk = true;
          setMediaDraft([...draft]);
        } catch (err) {
          groupFailed = true;
          fail('Images', err instanceof Error ? err.message : 'Image upload failed');
          break;
        }
      }
      if (!groupFailed) {
        for (const id of persistedMediaIds.filter((id) => !draft.some((e) => e.media_id === id))) {
          const r = await runAction('product.detachMedia', { productId: product.id, mediaId: id });
          if (r.ok) anyOk = true;
          else {
            groupFailed = true;
            fail('Images', r.error);
            break;
          }
        }
      }
      if (!groupFailed) {
        const finalIds = draft.map((e) => e.media_id).filter((id): id is string => id !== null);
        const attachedOrder = [
          ...persistedMediaIds.filter((id) => finalIds.includes(id)),
          ...attachedNewIds,
        ];
        if (
          finalIds.length > 0 &&
          (finalIds.length !== attachedOrder.length ||
            finalIds.some((id, i) => id !== attachedOrder[i]))
        ) {
          const r = await runAction('product.reorderMedia', {
            productId: product.id,
            mediaIds: finalIds,
            expectedMediaIds: attachedOrder,
          });
          if (r.ok) anyOk = true;
          else {
            groupFailed = true;
            fail('Images', r.error);
          }
        }
      }
      if (!groupFailed) {
        for (const entry of draft) {
          if (!entry.media_id || attachedNewIds.includes(entry.media_id)) continue;
          const persisted = product.media.find((m) => m.media_id === entry.media_id);
          if (!persisted || persisted.alt_text === entry.alt_text) continue;
          const r = await runAction('media.updateAlt', {
            mediaId: entry.media_id,
            altText: entry.alt_text,
          });
          if (r.ok) anyOk = true;
          else {
            groupFailed = true;
            fail('Images', r.error);
            break;
          }
        }
      }
      if (!groupFailed) {
        mediaOk = true;
        setMediaDraft([...draft]);
      }
    }

    if (collectionsDirty) {
      const persistedIds = product.collections.map((c) => c.id);
      const changes = [
        ...collectionIds
          .filter((id) => !persistedIds.includes(id))
          .map((id) => ({ id, included: true })),
        ...persistedIds
          .filter((id) => !collectionIds.includes(id))
          .map((id) => ({ id, included: false })),
      ];
      for (const ch of changes) {
        const r = await runAction('collection.toggleProduct', {
          collectionId: ch.id,
          productId: product.id,
          included: ch.included,
        });
        if (r.ok) anyOk = true;
        else fail('Collections', r.error);
      }
    }

    setBusy(false);
    if (anyOk) await refresh();
    if (failures.length > 0) {
      if (mediaOk && mediaDirty) setMediaDraft(null);
      setFeedback({ kind: 'error', message: failures.join(' ') });
    } else {
      setFeedback({ kind: 'status', message: 'Saved; publication pending.' });
      setEdits({});
      setStockDelta({});
      setStagedNewVariants([]);
      setDeletedVariantIds([]);
      revokeStaged(mediaDraft);
      setMediaDraft(null);
      setSelectedMediaKey(null);
      setSelectedVariants([]);
      setConflict(false);
      setTimeout(onClose, 0);
    }
  }

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <SheetContent
          className="w-full gap-0 overflow-hidden p-0 sm:max-w-4xl"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <SheetHeader className="p-5 pr-24 pb-0 sm:p-6 sm:pr-24 sm:pb-0">
            <SheetTitle>{product.title}</SheetTitle>
            <SheetDescription>
              /{product.slug} · {product.status}
            </SheetDescription>
          </SheetHeader>
          <div className="absolute top-3 right-12 z-20">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={sheetMenuOpen}
              aria-label={`Actions for ${product.title}`}
              onClick={(event) => {
                event.stopPropagation();
                setSheetMenuOpen(!sheetMenuOpen);
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-950"
            >
              <EllipsisIcon className="size-4" />
            </button>
            {sheetMenuOpen ? (
              <div
                role="menu"
                onClick={(event) => event.stopPropagation()}
                className="absolute top-full right-0 mt-1 w-44 rounded-xl border border-zinc-200 bg-white p-1 shadow-lg"
              >
                <Link
                  role="menuitem"
                  to="/products/$slug"
                  params={{ slug: product.slug }}
                  onClick={() => setSheetMenuOpen(false)}
                  className="block rounded-lg px-3 py-2 text-[13px] font-medium text-zinc-950 transition-colors hover:bg-zinc-50"
                >
                  View in store
                </Link>
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    setSheetMenuOpen(false);
                    setForm({ ...form, status: form.status === 'active' ? 'draft' : 'active' });
                  }}
                  className="block w-full rounded-lg px-3 py-2 text-left text-[13px] font-medium text-zinc-950 transition-colors hover:bg-zinc-50 disabled:opacity-40"
                >
                  {form.status === 'active' ? 'Move to draft' : 'Publish'}
                </button>
              </div>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            <Accordion type="multiple" value={openSections} onValueChange={setOpenSections}>
              <AccordionItem value="details">
                <AccordionTrigger>Details</AccordionTrigger>
                <AccordionContent>
                  <form
                    id="product-details-form"
                    className="space-y-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveAll();
                    }}
                  >
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
                    {product.revision !== null &&
                    (product.processed_revision ?? 0) < product.revision ? (
                      <p className={hintCls}>Publication pending for the latest saved revision.</p>
                    ) : null}
                  </form>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="images">
                <AccordionTrigger>Images</AccordionTrigger>
                <AccordionContent>
                  <Sortable
                    items={displayMedia.map((m) => m.key)}
                    onReorder={(keys) =>
                      setMediaDraft(
                        keys
                          .map((k) => displayMedia.find((e) => e.key === k))
                          .filter((e): e is MediaDraftEntry => e !== undefined)
                      )
                    }
                    className="grid grid-cols-2 gap-5 sm:grid-cols-3 sm:gap-6"
                  >
                    {displayMedia.map((m, i) => {
                      const isSelected = selectedMediaKey === m.key;
                      return (
                        <SortableItem key={m.key} id={m.key} className="group w-full">
                          <div className="relative">
                            <button
                              type="button"
                              aria-label={`Select image ${i + 1}`}
                              aria-pressed={isSelected}
                              onClick={() => setSelectedMediaKey(isSelected ? null : m.key)}
                              className={`block aspect-[4/5] w-full cursor-grab overflow-hidden rounded-xl bg-zinc-50 active:cursor-grabbing ${
                                isSelected ? 'ring-2 ring-zinc-950' : ''
                              }`}
                            >
                              <img
                                src={m.src}
                                alt={m.alt_text || `${product.title} image ${i + 1}`}
                                className="h-full w-full object-cover"
                              />
                            </button>
                            {i === 0 ? (
                              <span className="pointer-events-none absolute top-2 left-2 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-950 shadow-sm">
                                Cover
                              </span>
                            ) : null}
                            <button
                              type="button"
                              aria-label={`Remove image ${i + 1}`}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={() => {
                                if (m.file) URL.revokeObjectURL(m.src);
                                if (isSelected) setSelectedMediaKey(null);
                                setMediaDraft(displayMedia.filter((e) => e.key !== m.key));
                              }}
                              className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 transition-colors hover:text-zinc-950"
                            >
                              <XIcon className="size-3.5" />
                            </button>
                          </div>
                          <p className="mt-1.5 truncate text-xs text-zinc-600">
                            {m.alt_text || `Image ${i + 1}`}
                          </p>
                        </SortableItem>
                      );
                    })}
                    <label className="group/add w-full cursor-pointer text-left">
                      <span className="flex aspect-[4/5] flex-col items-center justify-center gap-1.5 rounded-xl bg-zinc-50 text-zinc-500 transition-colors group-hover/add:bg-zinc-100 group-hover/add:text-zinc-950">
                        <PlusIcon className="size-5" />
                        <span className="text-xs font-medium">Add</span>
                      </span>
                      <span
                        aria-hidden="true"
                        className="mt-1.5 block truncate text-xs text-zinc-600"
                      >
                        &nbsp;
                      </span>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        className="sr-only"
                        aria-label="Add product image"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (!file) return;
                          const entry: MediaDraftEntry = {
                            key: `staged-${Date.now()}`,
                            media_id: null,
                            r2_key: '',
                            src: URL.createObjectURL(file),
                            alt_text: '',
                            file,
                          };
                          setMediaDraft([...displayMedia, entry]);
                          setSelectedMediaKey(entry.key);
                        }}
                      />
                    </label>
                  </Sortable>
                  {(() => {
                    if (!selectedMediaKey) return null;
                    const idx = displayMedia.findIndex((row) => row.key === selectedMediaKey);
                    const m = displayMedia[idx];
                    if (!m) return null;
                    return (
                      <div className="mt-4 rounded-xl bg-zinc-50 p-3.5">
                        <p className="text-[13px] font-medium text-zinc-950">
                          Image {idx + 1} of {displayMedia.length}
                          {idx === 0 ? ' \u00b7 Cover' : ''}
                        </p>
                        <div className="mt-3 flex flex-wrap items-end gap-2">
                          <span className="min-w-48 flex-1">
                            <label className={labelCls} htmlFor={`alt-${m.key}`}>
                              Alt text
                            </label>
                            <input
                              id={`alt-${m.key}`}
                              className={inputCls}
                              value={m.alt_text}
                              onChange={(e) =>
                                setMediaDraft(
                                  displayMedia.map((e2) =>
                                    e2.key === m.key ? { ...e2, alt_text: e.target.value } : e2
                                  )
                                )
                              }
                            />
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="variants">
                <AccordionTrigger>Variants</AccordionTrigger>
                <AccordionContent>
                  <p className={hintCls}>
                    Price and original price are in dollars here and stored as cents. Stock changes
                    go through the ledger.
                  </p>
                  {visibleVariants.length > 1 ? (
                    <div className="mt-4 flex flex-wrap items-end gap-2 rounded-xl bg-zinc-50 p-3.5">
                      <span className="text-[13px] font-medium text-zinc-950">
                        Bulk edit
                        {selectedVariants.length ? ` (${selectedVariants.length} selected)` : ''}
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
                            selectedVariants.length === visibleVariants.length
                              ? []
                              : visibleVariants.map((v) => v.id)
                          )
                        }
                      >
                        {selectedVariants.length === visibleVariants.length
                          ? 'Clear selection'
                          : 'Select all'}
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
                          visibleVariants,
                          selectedVariants,
                          bulk.price ? Math.round(Number(bulk.price) * 100) : null
                        );
                        return (
                          <>
                            <h3 className="text-sm font-medium text-zinc-950">
                              Review price changes
                            </h3>
                            {review.errors.length > 0 ? (
                              <p className="mt-1 text-sm text-red-700" role="alert">
                                {review.errors.join(' ')}
                              </p>
                            ) : (
                              <ul className="mt-2 space-y-1 text-sm text-zinc-600">
                                {review.rows.map((row) => (
                                  <li key={row.id}>
                                    {row.sku} ({row.title}):{' '}
                                    {formatMoney(row.oldPriceCents, currency)} to{' '}
                                    {formatMoney(row.newPriceCents, currency)}
                                  </li>
                                ))}
                              </ul>
                            )}
                            <p className="mt-2 text-xs text-zinc-500">
                              Prices are staged and applied when you save. Stock is not changed
                              here.
                            </p>
                            <div className="mt-3 flex gap-2">
                              <button
                                type="button"
                                className={btnPrimary}
                                disabled={busy || review.errors.length > 0}
                                onClick={() => {
                                  for (const row of review.rows)
                                    editVariant(row.id, { price_cents: row.newPriceCents });
                                  setSelectedVariants([]);
                                  setBulk({ price: '' });
                                  setBulkReviewOpen(false);
                                }}
                              >
                                Stage price for {selectedVariants.length} selected
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
                    {visibleVariants.map((v) => {
                      const available = v.on_hand - v.reserved;
                      const parsedTotal = Number(stockDelta[v.id]);
                      const total = Number.isFinite(parsedTotal) ? parsedTotal : v.on_hand;
                      const setTotal = (next: number) =>
                        setStockDelta({
                          ...stockDelta,
                          [v.id]: String(Math.max(0, Math.trunc(next))),
                        });
                      return (
                        <div key={v.id} className="rounded-xl border border-zinc-200 p-4">
                          {visibleVariants.length > 1 ? (
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
                          <div className="grid gap-3">
                            <div>
                              <label className={labelCls} htmlFor={`v-title-${v.id}`}>
                                Variant Name
                              </label>
                              <input
                                id={`v-title-${v.id}`}
                                className={inputCls}
                                value={v.title}
                                onChange={(e) => editVariant(v.id, { title: e.target.value })}
                              />
                            </div>
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
                              <label className={labelCls} htmlFor={`v-weight-${v.id}`}>
                                Weight (g)
                              </label>
                              <input
                                id={`v-weight-${v.id}`}
                                aria-label={`Weight for ${v.sku}`}
                                type="number"
                                min="0"
                                className={inputCls}
                                value={v.weight_grams ?? ''}
                                onChange={(e) =>
                                  editVariant(v.id, {
                                    weight_grams:
                                      e.target.value === '' ? null : Number(e.target.value),
                                  })
                                }
                              />
                            </div>
                            <div>
                              <label className={labelCls} htmlFor={`v-price-${v.id}`}>
                                Price
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
                            <label className="flex items-center gap-2 text-sm text-zinc-950">
                              <Checkbox
                                checked={v.compare_at_cents != null}
                                onCheckedChange={(checked) =>
                                  editVariant(v.id, {
                                    compare_at_cents:
                                      checked === true
                                        ? (v.compare_at_cents ?? v.price_cents)
                                        : null,
                                  })
                                }
                              />
                              On sale
                            </label>
                            {v.compare_at_cents != null ? (
                              <div>
                                <label className={labelCls} htmlFor={`v-compare-${v.id}`}>
                                  Original Price
                                </label>
                                <input
                                  id={`v-compare-${v.id}`}
                                  inputMode="decimal"
                                  className={inputCls}
                                  value={
                                    v.compare_at_cents != null
                                      ? (v.compare_at_cents / 100).toString()
                                      : ''
                                  }
                                  placeholder="Optional"
                                  onChange={(e) =>
                                    editVariant(v.id, {
                                      compare_at_cents:
                                        e.target.value === ''
                                          ? null
                                          : Math.round(Number(e.target.value) * 100),
                                    })
                                  }
                                />
                              </div>
                            ) : null}
                          </div>
                          <div className="mt-4 flex items-start justify-between gap-4">
                            <div>
                              <span className="block text-sm font-medium text-zinc-900">
                                Inventory
                              </span>
                              <p
                                className={
                                  available <= 0
                                    ? 'mt-0.5 text-[13px] font-medium text-red-600'
                                    : available <= 5
                                      ? 'mt-0.5 text-[13px] font-medium text-yellow-800'
                                      : 'mt-0.5 text-[13px] text-zinc-500'
                                }
                              >
                                {v.reserved} reserved · {available} available (
                                {formatMoney(v.price_cents, currency)})
                              </p>
                            </div>
                            <span className="flex items-center rounded-full border border-zinc-300">
                              <button
                                type="button"
                                aria-label={`Decrease stock for ${v.sku}`}
                                disabled={busy || total <= 0}
                                onClick={() => setTotal(total - 1)}
                                className="flex h-9 w-8 items-center justify-center text-zinc-600 transition-colors hover:text-zinc-950 disabled:opacity-40"
                              >
                                <MinusIcon className="size-4" />
                              </button>
                              <input
                                id={`v-stock-${v.id}`}
                                inputMode="numeric"
                                aria-label={`Stock total for ${v.sku}`}
                                className="w-12 bg-transparent text-center text-sm font-medium text-zinc-950 outline-none"
                                value={stockDelta[v.id] ?? String(v.on_hand)}
                                onChange={(e) =>
                                  setStockDelta({ ...stockDelta, [v.id]: e.target.value })
                                }
                                onBlur={(e) => {
                                  if (e.target.value.trim() === '') {
                                    const next = { ...stockDelta };
                                    delete next[v.id];
                                    setStockDelta(next);
                                  }
                                }}
                              />
                              <button
                                type="button"
                                aria-label={`Increase stock for ${v.sku}`}
                                disabled={busy}
                                onClick={() => setTotal(total + 1)}
                                className="flex h-9 w-8 items-center justify-center text-zinc-600 transition-colors hover:text-zinc-950 disabled:opacity-40"
                              >
                                <PlusIcon className="size-4" />
                              </button>
                            </span>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
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
                            <span className="ml-auto">
                              <button
                                type="button"
                                className={btnDestructive}
                                disabled={busy || visibleVariants.length <= 1}
                                onClick={() => setDeletedVariantIds([...deletedVariantIds, v.id])}
                              >
                                Delete
                              </button>
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {deletedVariantIds.map((id) => {
                    const v = product.variants.find((x) => x.id === id);
                    if (!v) return null;
                    return (
                      <p key={id} className="mt-3 text-sm text-zinc-600">
                        {v.sku} will be deleted.{' '}
                        <button
                          type="button"
                          className="font-medium text-zinc-950 underline"
                          onClick={() =>
                            setDeletedVariantIds(deletedVariantIds.filter((x) => x !== id))
                          }
                        >
                          Undo
                        </button>
                      </p>
                    );
                  })}
                  {stagedNewVariants.map((nv) => (
                    <div
                      key={nv.localId}
                      className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 p-4 text-sm"
                    >
                      <span className="font-medium text-zinc-950">{nv.sku}</span>
                      <span className="text-zinc-600">{nv.title || 'Default'}</span>
                      <span className="text-zinc-600">{nv.price}</span>
                      <span className="text-zinc-500">New — will be added on save</span>
                      <button
                        type="button"
                        className={btnSmall}
                        onClick={() =>
                          setStagedNewVariants(
                            stagedNewVariants.filter((x) => x.localId !== nv.localId)
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <form
                    className="mt-4 grid gap-3 rounded-xl bg-zinc-50 p-4 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setStagedNewVariants([
                        ...stagedNewVariants,
                        {
                          localId: `new-${Date.now()}`,
                          sku: newVariant.sku,
                          title: newVariant.title,
                          price: newVariant.price,
                        },
                      ]);
                      setNewVariant({ sku: '', title: '', price: '29.99' });
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
                        Price
                      </label>
                      <input
                        id="nv-price"
                        inputMode="decimal"
                        className={inputCls}
                        value={newVariant.price}
                        onChange={(e) => setNewVariant({ ...newVariant, price: e.target.value })}
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={busy || !newVariant.sku}
                      className={btnSecondary}
                    >
                      Add variant
                    </button>
                  </form>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="collections">
                <AccordionTrigger>Collections</AccordionTrigger>
                <AccordionContent>
                  {product.allCollections.length === 0 ? (
                    <p className={hintCls}>
                      No collections exist yet. Create one in Admin → Collections.
                    </p>
                  ) : (
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          disabled={busy}
                          className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-left text-sm text-zinc-950 transition-colors focus-visible:ring-[3px] focus-visible:ring-zinc-950/20 focus-visible:outline-none disabled:opacity-50"
                        >
                          <span
                            className={`truncate ${collectionIds.length === 0 ? 'text-zinc-400' : ''}`}
                          >
                            {collectionIds.length === 0
                              ? 'Select collections'
                              : product.allCollections
                                  .filter((c) => collectionIds.includes(c.id))
                                  .map((c) => c.title)
                                  .join(', ')}
                          </span>
                          <ChevronDownIcon className="size-4 shrink-0 text-zinc-400" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="max-h-64 overflow-y-auto">
                        {product.allCollections.map((c) => {
                          const on = collectionIds.includes(c.id);
                          return (
                            <button
                              key={c.id}
                              type="button"
                              disabled={busy}
                              aria-pressed={on}
                              onClick={() => {
                                setCollectionIds(
                                  on
                                    ? collectionIds.filter((x) => x !== c.id)
                                    : [...collectionIds, c.id]
                                );
                              }}
                              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-zinc-950 transition-colors hover:bg-zinc-50 disabled:opacity-50"
                            >
                              <Checkbox
                                checked={on}
                                tabIndex={-1}
                                className="pointer-events-none"
                              />
                              <span className="truncate">{c.title}</span>
                            </button>
                          );
                        })}
                      </PopoverContent>
                    </Popover>
                  )}
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="metadata">
                <AccordionTrigger>Metadata</AccordionTrigger>
                <AccordionContent>
                  <div className="mt-4">
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
                  </div>
                  <div className="mt-4">
                    <label className={labelCls} htmlFor="e-seo-desc">
                      SEO description
                    </label>
                    <textarea
                      id="e-seo-desc"
                      className={textareaCls}
                      rows={3}
                      value={form.seoDescription}
                      onChange={(e) => setForm({ ...form, seoDescription: e.target.value })}
                      placeholder="Defaults to the description"
                    />
                  </div>
                  <div className="mt-4">
                    <SeoPreview
                      path={`/products/${form.slug}`}
                      seoTitle={form.seoTitle}
                      seoDescription={form.seoDescription}
                      titleFallback={form.title || 'Product title'}
                      descriptionFallback={form.description}
                      emptyDescription="No description yet. Search engines will use the product page content."
                    />
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
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
          </div>
          {anyDirty ? (
            <div className="border-t border-zinc-100 bg-white px-5 py-3.5 sm:px-6">
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  className={btnSmall}
                  disabled={busy}
                  onClick={discardAndClose}
                >
                  Discard
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={btnPrimary}
                  onClick={() => void saveAll()}
                >
                  {busy ? 'Saving...' : 'Save changes'}
                </button>
              </div>
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

          <ConfirmDialog
            request={
              closeDiscard
                ? {
                    title: 'Discard unsaved changes?',
                    body: "Your changes to this product haven't been saved.",
                    confirmLabel: 'Discard changes',
                  }
                : null
            }
            busy={busy}
            onCancel={() => setCloseDiscard(false)}
            onConfirm={discardAndClose}
          />
        </SheetContent>
      </Sheet>
      <AdminActionFeedback value={feedback} />
    </>
  );
}

import { Suspense, lazy, useEffect, useState } from 'react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';
import { createServerFn } from '@tanstack/react-start';
import { staffMiddleware } from '../server/staff-middleware';
import { uploadMedia } from '../lib/upload';
import { getRouteApi } from '@tanstack/react-router';
import { AdminActionFeedback, type AdminActionFeedbackState } from './AdminActionFeedback';
import { AdminDataTableShell } from './AdminDataTable';
import { useAdminAction } from './AdminNav';
import {
  emptyProductCreateDraft,
  productCreatePayload,
  productCreateServerField,
  suggestedProductSlug,
  validateProductCreateDraft,
  type ProductCreateDraft,
  type ProductCreateErrors,
} from '../lib/product-create';
import {
  MAX_OPTION_GROUPS,
  MAX_VARIANT_COMBINATIONS,
  countCombinations,
  droppedEditedCombinations,
  generateVariantCombinations,
  validateOptionGroups,
  validateVariantCombinations,
  type VariantCombination,
  type VariantOptionGroup,
} from '../lib/product-variant-options';
import { ConfirmDialog, type ConfirmRequest } from './ConfirmDialog';
import { SeoPreview } from './SeoPreview';
import { roleCan } from '../lib/permissions';
import { parseMoneyCents } from '../lib/format';
import { btnPrimary, btnSmall, hintCls, inputCls, labelCls, textareaCls } from './ui';
import { Button } from './ui/button';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from './ui/drawer';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import { Sortable, SortableItem } from './ui/sortable';
import { plainTextToRichHtml, richHtmlToPlainText } from '../lib/rich-text';

const ExpandableEditor = lazy(async () => ({
  default: (await import('./ExpandableEditor')).ExpandableEditor,
}));
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Checkbox } from './ui/checkbox';
import { ChevronDownIcon, MinusIcon, PlusIcon, XIcon } from 'lucide-react';

export const getCollectionOptions = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .handler(async (): Promise<Array<{ id: string; title: string }>> => {
    const { env } = await import('cloudflare:workers');
    const rows = await env.DB.prepare('SELECT id, title FROM collections ORDER BY title').all<{
      id: string;
      title: string;
    }>();
    return rows.results;
  });

type StagedImage = { key: string; file: File; src: string; alt: string };

const adminApi = getRouteApi('/admin');

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-xs text-red-700" role="alert">
      {message}
    </p>
  );
}

export function ProductCreateDrawer({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (productId?: string) => void;
}) {
  const adminAction = useAdminAction();
  const { staff } = adminApi.useRouteContext();
  const canCreate = roleCan(staff?.role, 'product', 'create');
  const [draft, setDraft] = useState<ProductCreateDraft>(emptyProductCreateDraft);
  const [stagedImages, setStagedImages] = useState<StagedImage[]>([]);
  const [selectedImageKey, setSelectedImageKey] = useState<string | null>(null);
  const [collectionOptions, setCollectionOptions] = useState<Array<{
    id: string;
    title: string;
  }> | null>(null);
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  useEffect(() => {
    if (!open || collectionOptions !== null) return;
    let cancelled = false;
    getCollectionOptions()
      .then((rows) => {
        if (!cancelled) setCollectionOptions(rows);
      })
      .catch(() => {
        if (!cancelled) setCollectionOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, collectionOptions]);
  const [slugTouched, setSlugTouched] = useState(false);
  const [errors, setErrors] = useState<ProductCreateErrors>({});
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [busy, setBusy] = useState(false);
  const [uploadPending, setUploadPending] = useState(false);
  const [openSections, setOpenSections] = useState<string[]>(['product-details']);
  useEffect(() => {
    if (open) setOpenSections(['product-details']);
  }, [open]);
  const [useOptions, setUseOptions] = useState(false);
  const [groups, setGroups] = useState<VariantOptionGroup[]>([
    { name: 'Size', valuesText: 'Small, Medium, Large' },
    { name: 'Color', valuesText: 'Black, White' },
  ]);
  const [editedKeys, setEditedKeys] = useState<ReadonlySet<string>>(new Set());
  const [combinations, setCombinations] = useState<VariantCombination[]>([]);
  const [optionErrors, setOptionErrors] = useState<string[]>([]);
  const [resetArmed, setResetArmed] = useState(false);

  const parsedStock = Number(draft.stock);
  const stockTotal = Number.isFinite(parsedStock) ? Math.max(0, Math.trunc(parsedStock)) : 0;
  const combinationCount = countCombinations(groups);

  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [pendingGroups, setPendingGroups] = useState<VariantOptionGroup[] | null>(null);

  const requestOptionChange = (nextGroups: VariantOptionGroup[]): void => {
    const dropped = droppedEditedCombinations(
      combinations,
      editedKeys,
      generateVariantCombinations(
        nextGroups,
        draft.slug || suggestedProductSlug(draft.title),
        { price: draft.price, stock: draft.stock },
        combinations
      )
    );
    if (dropped.length === 0) {
      setGroups(nextGroups);
      regenerate(nextGroups, combinations);
      return;
    }
    setPendingGroups(nextGroups);
    setConfirmRequest({
      title: 'Remove edited variants?',
      body: `This removes ${dropped.length} edited variant(s): ${dropped.map((combo) => combo.title).join(', ')}. Their SKU, price, and stock edits will be lost.`,
      confirmLabel: 'Remove variants',
    });
  };

  const regenerate = (nextGroups: VariantOptionGroup[], previous: VariantCombination[]) => {
    setCombinations(
      generateVariantCombinations(
        nextGroups,
        draft.slug || suggestedProductSlug(draft.title),
        { price: draft.price, stock: draft.stock },
        previous
      )
    );
  };

  const set = <K extends keyof ProductCreateDraft>(key: K, value: ProductCreateDraft[K]) => {
    setDraft((current) => {
      const next = { ...current, [key]: value };
      if (key === 'title' && !slugTouched) next.slug = suggestedProductSlug(String(value));
      return next;
    });
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  if (!canCreate) return null;

  return (
    <>
      <Drawer instant swipeDirection="right" open={open} onOpenChange={onOpenChange}>
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
            <DrawerTitle>New product</DrawerTitle>
            <DrawerDescription>
              {useOptions
                ? `Create the product and ${combinationCount} variants in one step.`
                : 'Create the complete product — details, images, variants, and collections — in one step.'}
            </DrawerDescription>
          </DrawerHeader>
          <ConfirmDialog
            request={confirmRequest}
            busy={busy}
            onConfirm={() => {
              if (pendingGroups) {
                setGroups(pendingGroups);
                regenerate(pendingGroups, combinations);
              }
              setPendingGroups(null);
              setConfirmRequest(null);
            }}
            onCancel={() => {
              setPendingGroups(null);
              setConfirmRequest(null);
            }}
          />

          <form
            className="flex min-h-0 flex-1 flex-col"
            noValidate
            onSubmit={async (event) => {
              event.preventDefault();
              const baseErrors = validateProductCreateDraft(draft);
              const nextErrors = useOptions
                ? {
                    ...baseErrors,
                    sku: undefined,
                    variantTitle: undefined,
                    price: undefined,
                    stock: undefined,
                  }
                : baseErrors;
              setErrors(nextErrors);
              const nextOptionErrors = useOptions
                ? [
                    ...validateOptionGroups(groups),
                    ...validateVariantCombinations(combinations, combinationCount),
                  ]
                : [];
              setOptionErrors(nextOptionErrors);
              if (Object.values(nextErrors).some(Boolean) || nextOptionErrors.length > 0) {
                setFeedback({
                  kind: 'error',
                  message: 'Fix the highlighted fields and try again.',
                });
                return;
              }
              setBusy(true);
              const payload = productCreatePayload(draft);
              if (useOptions) {
                payload.variants = combinations.map((combo) => ({
                  sku: combo.sku.trim(),
                  title: combo.title,
                  priceCents: (() => {
                    const parsed = parseMoneyCents(combo.price);
                    return parsed.ok ? parsed.cents : 0;
                  })(),
                  compareAtCents: (() => {
                    const parsed = parseMoneyCents(combo.compareAt);
                    return combo.compareAt.trim() !== '' && parsed.ok ? parsed.cents : null;
                  })(),
                  stock: Number(combo.stock),
                  weightGrams: draft.weightGrams.trim() === '' ? null : Number(draft.weightGrams),
                  continueSelling: draft.continueSelling,
                }));
              }
              const result = await adminAction('product.create', payload);
              if (result.ok) {
                const data = result.data as { productId?: string } | undefined;
                if (data?.productId) {
                  const productId = data.productId;
                  const failures: string[] = [];
                  for (const img of stagedImages) {
                    try {
                      const uploaded = await uploadMedia(img.file, img.alt);
                      const attach = await adminAction('product.attachMedia', {
                        productId,
                        mediaId: uploaded.id,
                      });
                      if (!attach.ok)
                        failures.push(`an image couldn't be attached \u2014 ${attach.error}`);
                    } catch (error) {
                      failures.push(
                        `an image couldn't be attached \u2014 ${error instanceof Error ? error.message : 'upload failed'}`
                      );
                    }
                  }
                  for (const collectionId of collectionIds) {
                    const toggle = await adminAction('collection.toggleProduct', {
                      collectionId,
                      productId,
                      included: true,
                    });
                    if (!toggle.ok)
                      failures.push(`a collection couldn't be added \u2014 ${toggle.error}`);
                  }
                  for (const img of stagedImages) URL.revokeObjectURL(img.src);
                  setStagedImages([]);
                  setSelectedImageKey(null);
                  setCollectionIds([]);
                  setBusy(false);
                  if (failures.length > 0) {
                    setFeedback({
                      kind: 'error',
                      message: `Product created, but ${failures[0]}`,
                    });
                  }
                  onCreated(productId);
                  return;
                }
                setBusy(false);
                setFeedback({ kind: 'status', message: 'Product created.' });
                onCreated(undefined);
                return;
              }
              setBusy(false);
              if ('uncertain' in result && result.uncertain) {
                setFeedback({
                  kind: 'error',
                  message:
                    'This may have been created. Check the product list for the title or slug before submitting again.',
                });
                return;
              }
              const field = productCreateServerField(result.error);
              if (field === 'sku' && useOptions)
                setOptionErrors([`${result.error} Check the SKU column in the table.`]);
              else if (field) setErrors({ [field]: result.error });
              setFeedback({
                kind: 'error',
                message:
                  result.error ?? 'Product could not be created. Your entries are still here.',
              });
            }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              <Accordion type="multiple" value={openSections} onValueChange={setOpenSections}>
                <AccordionItem value="product-details">
                  <AccordionTrigger>Details</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <div>
                      <p className={labelCls}>Images</p>
                      <Sortable
                        items={stagedImages.map((m) => m.key)}
                        onReorder={(keys) =>
                          setStagedImages(
                            keys
                              .map((k) => stagedImages.find((e) => e.key === k))
                              .filter((e): e is StagedImage => e !== undefined)
                          )
                        }
                        className="grid grid-cols-2 gap-5 sm:grid-cols-3 sm:gap-6"
                      >
                        {stagedImages.map((m, i) => {
                          const isSelected = selectedImageKey === m.key;
                          return (
                            <SortableItem key={m.key} id={m.key} className="group w-full">
                              <div className="relative">
                                <button
                                  type="button"
                                  aria-label={`Select image ${i + 1}`}
                                  aria-pressed={isSelected}
                                  onClick={() => setSelectedImageKey(isSelected ? null : m.key)}
                                  className={`block aspect-[4/5] w-full cursor-grab overflow-hidden rounded-xl bg-zinc-50 active:cursor-grabbing ${
                                    isSelected ? 'ring-2 ring-zinc-950' : ''
                                  }`}
                                >
                                  <img
                                    src={m.src}
                                    alt={m.alt || `${draft.title || 'Product'} image ${i + 1}`}
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
                                    URL.revokeObjectURL(m.src);
                                    if (isSelected) setSelectedImageKey(null);
                                    setStagedImages(stagedImages.filter((e) => e.key !== m.key));
                                  }}
                                  className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 transition-colors hover:text-zinc-950"
                                >
                                  <XIcon className="size-3.5" />
                                </button>
                              </div>
                              <p className="mt-1.5 truncate text-xs text-zinc-600">
                                {m.alt || `Image ${i + 1}`}
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
                              const entry: StagedImage = {
                                key: `staged-${Date.now()}`,
                                file,
                                src: URL.createObjectURL(file),
                                alt: '',
                              };
                              setStagedImages([...stagedImages, entry]);
                              setSelectedImageKey(entry.key);
                            }}
                          />
                        </label>
                      </Sortable>
                      {(() => {
                        if (!selectedImageKey) return null;
                        const idx = stagedImages.findIndex((row) => row.key === selectedImageKey);
                        const m = stagedImages[idx];
                        if (!m) return null;
                        return (
                          <div className="mt-4 rounded-xl bg-zinc-50 p-3.5">
                            <p className="text-[13px] font-medium text-zinc-950">
                              Image {idx + 1} of {stagedImages.length}
                              {idx === 0 ? ' \u00b7 Cover' : ''}
                            </p>
                            <div className="mt-3">
                              <label className={labelCls} htmlFor={`new-alt-${m.key}`}>
                                Alt text
                              </label>
                              <input
                                id={`new-alt-${m.key}`}
                                className={inputCls}
                                value={m.alt}
                                onChange={(e) =>
                                  setStagedImages(
                                    stagedImages.map((e2) =>
                                      e2.key === m.key ? { ...e2, alt: e.target.value } : e2
                                    )
                                  )
                                }
                              />
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    <div>
                      <label className={labelCls} htmlFor="new-title">
                        Title
                      </label>
                      <input
                        id="new-title"
                        className={inputCls}
                        value={draft.title}
                        maxLength={300}
                        aria-invalid={Boolean(errors.title)}
                        aria-describedby={errors.title ? 'new-title-error' : undefined}
                        onChange={(event) => set('title', event.target.value)}
                      />
                      <FieldError id="new-title-error" message={errors.title} />
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className={labelCls} htmlFor="new-slug">
                          Slug
                        </label>
                        <input
                          id="new-slug"
                          className={inputCls}
                          value={draft.slug}
                          aria-invalid={Boolean(errors.slug)}
                          aria-describedby={errors.slug ? 'new-slug-error' : undefined}
                          onChange={(event) => {
                            setSlugTouched(true);
                            set('slug', event.target.value);
                          }}
                        />
                        <FieldError id="new-slug-error" message={errors.slug} />
                      </div>
                      <div>
                        <label className={labelCls} htmlFor="new-status">
                          Status
                        </label>
                        <select
                          id="new-status"
                          className={inputCls}
                          value={draft.status}
                          onChange={(event) =>
                            set('status', event.target.value === 'active' ? 'active' : 'draft')
                          }
                        >
                          <option value="draft">Draft</option>
                          <option value="active">Active</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <Suspense
                        fallback={
                          <div
                            className="min-h-56 rounded-xl border border-zinc-200 bg-white px-5 py-4 text-sm text-zinc-500"
                            role="status"
                          >
                            Loading editor…
                          </div>
                        }
                      >
                        <ExpandableEditor
                          label="Description"
                          editorKey="new"
                          initialHtml={plainTextToRichHtml(draft.description)}
                          onChange={(html) => set('description', html)}
                          onUploadPendingChange={setUploadPending}
                        />
                      </Suspense>
                      <FieldError id="new-description-error" message={errors.description} />
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="first-variant">
                  <AccordionTrigger>Variants</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    {useOptions ? (
                      <p className={hintCls}>
                        Price and stock below apply only when a combination is first generated.
                        Weight and continue selling apply to every variant.
                      </p>
                    ) : null}
                    <div className="grid gap-4">
                      {useOptions ? null : (
                        <>
                          <div>
                            <label className={labelCls} htmlFor="new-variant-title">
                              Variant Name
                            </label>
                            <input
                              id="new-variant-title"
                              className={inputCls}
                              value={draft.variantTitle}
                              maxLength={200}
                              aria-invalid={Boolean(errors.variantTitle)}
                              aria-describedby={
                                errors.variantTitle ? 'new-variant-title-error' : undefined
                              }
                              onChange={(event) => set('variantTitle', event.target.value)}
                            />
                            <FieldError
                              id="new-variant-title-error"
                              message={errors.variantTitle}
                            />
                          </div>
                          <div>
                            <label className={labelCls} htmlFor="new-sku">
                              SKU
                            </label>
                            <input
                              id="new-sku"
                              className={inputCls}
                              value={draft.sku}
                              maxLength={100}
                              aria-invalid={Boolean(errors.sku)}
                              aria-describedby={errors.sku ? 'new-sku-error' : undefined}
                              onChange={(event) => set('sku', event.target.value)}
                            />
                            <FieldError id="new-sku-error" message={errors.sku} />
                          </div>
                        </>
                      )}
                      <div>
                        <label className={labelCls} htmlFor="new-weight">
                          Weight (grams, optional)
                        </label>
                        <input
                          id="new-weight"
                          className={inputCls}
                          inputMode="numeric"
                          value={draft.weightGrams}
                          aria-invalid={Boolean(errors.weightGrams)}
                          aria-describedby={errors.weightGrams ? 'new-weight-error' : undefined}
                          onChange={(event) => set('weightGrams', event.target.value)}
                        />
                        <FieldError id="new-weight-error" message={errors.weightGrams} />
                      </div>
                      <div>
                        <label className={labelCls} htmlFor="new-price">
                          Price
                        </label>
                        <input
                          id="new-price"
                          className={inputCls}
                          inputMode="decimal"
                          value={draft.price}
                          aria-invalid={Boolean(errors.price)}
                          aria-describedby={errors.price ? 'new-price-error' : undefined}
                          onChange={(event) => set('price', event.target.value)}
                        />
                        <FieldError id="new-price-error" message={errors.price} />
                      </div>
                      {useOptions ? null : (
                        <>
                          <label className="flex items-center gap-2 text-sm text-zinc-950">
                            <Checkbox
                              checked={draft.compareAt.trim() !== ''}
                              onCheckedChange={(checked) =>
                                set('compareAt', checked === true ? draft.price : '')
                              }
                            />
                            On sale
                          </label>
                          {draft.compareAt.trim() !== '' ? (
                            <div>
                              <label className={labelCls} htmlFor="new-compare">
                                Original Price
                              </label>
                              <input
                                id="new-compare"
                                className={inputCls}
                                inputMode="decimal"
                                value={draft.compareAt}
                                onChange={(event) => set('compareAt', event.target.value)}
                              />
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <span className="block text-sm font-medium text-zinc-900">Inventory</span>
                        <p className="mt-0.5 text-[13px] text-zinc-500">Initial stock on hand</p>
                      </div>
                      <span className="flex items-center rounded-full border border-zinc-300">
                        <button
                          type="button"
                          aria-label="Decrease initial stock"
                          disabled={stockTotal <= 0}
                          onClick={() => set('stock', String(stockTotal - 1))}
                          className="flex h-9 w-8 items-center justify-center text-zinc-600 transition-colors hover:text-zinc-950 disabled:opacity-40"
                        >
                          <MinusIcon className="size-4" />
                        </button>
                        <input
                          id="new-stock"
                          inputMode="numeric"
                          aria-label="Initial stock"
                          aria-invalid={Boolean(errors.stock)}
                          aria-describedby={errors.stock ? 'new-stock-error' : undefined}
                          className="w-12 bg-transparent text-center text-sm font-medium text-zinc-950 outline-none"
                          value={draft.stock}
                          onChange={(event) => set('stock', event.target.value)}
                          onBlur={(event) => {
                            if (event.target.value.trim() === '') set('stock', '0');
                          }}
                        />
                        <button
                          type="button"
                          aria-label="Increase initial stock"
                          onClick={() => set('stock', String(stockTotal + 1))}
                          className="flex h-9 w-8 items-center justify-center text-zinc-600 transition-colors hover:text-zinc-950 disabled:opacity-40"
                        >
                          <PlusIcon className="size-4" />
                        </button>
                      </span>
                    </div>
                    <FieldError id="new-stock-error" message={errors.stock} />
                    <div>
                      <label className="flex items-end gap-2 pb-2 text-sm text-zinc-700">
                        <input
                          type="checkbox"
                          checked={draft.continueSelling}
                          onChange={(event) => set('continueSelling', event.target.checked)}
                        />
                        Continue selling when out of stock
                      </label>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="variant-options">
                  <AccordionTrigger>Variant options</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <label className="flex items-center gap-2 text-sm text-zinc-700">
                        <input
                          type="checkbox"
                          checked={useOptions}
                          onChange={(event) => {
                            setResetArmed(false);
                            setUseOptions(event.target.checked);
                            if (event.target.checked && combinations.length === 0)
                              regenerate(groups, []);
                          }}
                        />
                        Create variants from options
                      </label>
                    </div>
                    {useOptions ? (
                      <div className="space-y-4">
                        <p className={hintCls}>
                          Add option groups such as Size and Color. Every combination becomes one
                          variant. At most {MAX_VARIANT_COMBINATIONS} variants can be created at
                          once. This product currently makes {countCombinations(groups)}{' '}
                          combinations.
                        </p>
                        {combinationCount > MAX_VARIANT_COMBINATIONS ? (
                          <p role="alert" className="text-xs text-red-700">
                            {combinationCount} combinations exceed the limit of{' '}
                            {MAX_VARIANT_COMBINATIONS} variants. Reduce option values.
                          </p>
                        ) : null}
                        {groups.map((group, groupIndex) => (
                          <div key={groupIndex} className="grid gap-3 sm:grid-cols-2">
                            <div>
                              <label className={labelCls} htmlFor={`group-name-${groupIndex}`}>
                                Option name
                              </label>
                              <input
                                id={`group-name-${groupIndex}`}
                                className={inputCls}
                                value={group.name}
                                onChange={(event) => {
                                  setResetArmed(false);
                                  const next = groups.map((item, index) =>
                                    index === groupIndex
                                      ? { ...item, name: event.target.value }
                                      : item
                                  );
                                  setGroups(next);
                                }}
                              />
                            </div>
                            <div>
                              <label className={labelCls} htmlFor={`group-values-${groupIndex}`}>
                                Values, separated by commas
                              </label>
                              <input
                                id={`group-values-${groupIndex}`}
                                className={inputCls}
                                value={group.valuesText}
                                onChange={(event) => {
                                  setResetArmed(false);
                                  const next = groups.map((item, index) =>
                                    index === groupIndex
                                      ? { ...item, valuesText: event.target.value }
                                      : item
                                  );
                                  requestOptionChange(next);
                                }}
                              />
                            </div>
                          </div>
                        ))}
                        <div className="flex flex-wrap gap-2">
                          {groups.map((group, groupIndex) => (
                            <button
                              key={groupIndex}
                              type="button"
                              className={btnSmall}
                              disabled={groups.length <= 1}
                              onClick={() => {
                                setResetArmed(false);
                                const next = groups.filter((_, index) => index !== groupIndex);
                                requestOptionChange(next);
                              }}
                            >
                              Remove {group.name.trim() || `option ${groupIndex + 1}`}
                            </button>
                          ))}
                          <button
                            type="button"
                            className={btnSmall}
                            disabled={groups.length >= MAX_OPTION_GROUPS}
                            onClick={() => {
                              setResetArmed(false);
                              setGroups([...groups, { name: '', valuesText: '' }]);
                            }}
                          >
                            Add option group
                          </button>
                          <button
                            type="button"
                            className={btnSmall}
                            onClick={() => regenerate(groups, combinations)}
                          >
                            Refresh combinations
                          </button>
                          <button
                            type="button"
                            className={btnSmall}
                            onClick={() => {
                              if (!resetArmed) {
                                setResetArmed(true);
                                return;
                              }
                              setCombinations(
                                generateVariantCombinations(
                                  groups,
                                  draft.slug || suggestedProductSlug(draft.title),
                                  { price: draft.price, stock: draft.stock },
                                  []
                                )
                              );
                              setResetArmed(false);
                            }}
                          >
                            {resetArmed
                              ? 'Click again to discard combination edits'
                              : 'Reset combination details'}
                          </button>
                        </div>
                        {optionErrors.length > 0 ? (
                          <div role="alert" className="text-xs text-red-700">
                            {optionErrors.map((message) => (
                              <p key={message}>{message}</p>
                            ))}
                          </div>
                        ) : null}
                        {combinations.length > 0 ? (
                          <div>
                            <AdminDataTableShell>
                              <Table className="min-w-[640px]">
                                <TableCaption className="sr-only">
                                  Variant combinations to create
                                </TableCaption>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Variant</TableHead>
                                    <TableHead>SKU</TableHead>
                                    <TableHead>Price</TableHead>
                                    <TableHead>Original Price</TableHead>
                                    <TableHead>Stock</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {combinations.map((combo, index) => (
                                    <TableRow key={combo.key}>
                                      <TableCell>{combo.title}</TableCell>
                                      <TableCell>
                                        <input
                                          aria-label={`SKU for ${combo.title}`}
                                          className={inputCls}
                                          value={combo.sku}
                                          onChange={(event) => {
                                            setResetArmed(false);
                                            setEditedKeys((current) =>
                                              new Set(current).add(combo.key)
                                            );
                                            setCombinations((current) =>
                                              current.map((item, itemIndex) =>
                                                itemIndex === index
                                                  ? { ...item, sku: event.target.value }
                                                  : item
                                              )
                                            );
                                          }}
                                        />
                                      </TableCell>
                                      <TableCell>
                                        <input
                                          aria-label={`Price for ${combo.title}`}
                                          className={inputCls}
                                          inputMode="decimal"
                                          value={combo.price}
                                          onChange={(event) => {
                                            setResetArmed(false);
                                            setEditedKeys((current) =>
                                              new Set(current).add(combo.key)
                                            );
                                            setCombinations((current) =>
                                              current.map((item, itemIndex) =>
                                                itemIndex === index
                                                  ? { ...item, price: event.target.value }
                                                  : item
                                              )
                                            );
                                          }}
                                        />
                                      </TableCell>
                                      <TableCell>
                                        <input
                                          aria-label={`Original price for ${combo.title}`}
                                          className={inputCls}
                                          inputMode="decimal"
                                          value={combo.compareAt}
                                          placeholder="Optional"
                                          onChange={(event) => {
                                            setResetArmed(false);
                                            setEditedKeys((current) =>
                                              new Set(current).add(combo.key)
                                            );
                                            setCombinations((current) =>
                                              current.map((item, itemIndex) =>
                                                itemIndex === index
                                                  ? { ...item, compareAt: event.target.value }
                                                  : item
                                              )
                                            );
                                          }}
                                        />
                                      </TableCell>
                                      <TableCell>
                                        <input
                                          aria-label={`Stock for ${combo.title}`}
                                          className={inputCls}
                                          inputMode="numeric"
                                          value={combo.stock}
                                          onChange={(event) => {
                                            setResetArmed(false);
                                            setEditedKeys((current) =>
                                              new Set(current).add(combo.key)
                                            );
                                            setCombinations((current) =>
                                              current.map((item, itemIndex) =>
                                                itemIndex === index
                                                  ? { ...item, stock: event.target.value }
                                                  : item
                                              )
                                            );
                                          }}
                                        />
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </AdminDataTableShell>
                          </div>
                        ) : (
                          <p className={hintCls}>Add option values to preview the combinations.</p>
                        )}
                      </div>
                    ) : (
                      <p className={hintCls}>
                        Leave this off to create one variant from the First variant fields.
                      </p>
                    )}
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="collections">
                  <AccordionTrigger>Collections</AccordionTrigger>
                  <AccordionContent>
                    {collectionOptions === null ? (
                      <p className={hintCls}>Loading collections\u2026</p>
                    ) : collectionOptions.length === 0 ? (
                      <p className={hintCls}>
                        No collections exist yet. Create one in Admin \u2192 Collections.
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
                                : collectionOptions
                                    .filter((c) => collectionIds.includes(c.id))
                                    .map((c) => c.title)
                                    .join(', ')}
                            </span>
                            <ChevronDownIcon className="size-4 shrink-0 text-zinc-400" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="max-h-64 overflow-y-auto">
                          {collectionOptions.map((c) => {
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
                  <AccordionContent className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className={labelCls} htmlFor="new-seo-title">
                          SEO title
                        </label>
                        <input
                          id="new-seo-title"
                          className={inputCls}
                          value={draft.seoTitle}
                          maxLength={300}
                          aria-invalid={Boolean(errors.seoTitle)}
                          aria-describedby={errors.seoTitle ? 'new-seo-title-error' : undefined}
                          onChange={(event) => set('seoTitle', event.target.value)}
                        />
                        <FieldError id="new-seo-title-error" message={errors.seoTitle} />
                      </div>
                    </div>
                    <div>
                      <label className={labelCls} htmlFor="new-seo-description">
                        SEO description
                      </label>
                      <textarea
                        id="new-seo-description"
                        className={textareaCls}
                        rows={3}
                        value={draft.seoDescription}
                        maxLength={500}
                        aria-invalid={Boolean(errors.seoDescription)}
                        aria-describedby={
                          errors.seoDescription ? 'new-seo-description-error' : undefined
                        }
                        onChange={(event) => set('seoDescription', event.target.value)}
                      />
                      <FieldError id="new-seo-description-error" message={errors.seoDescription} />
                    </div>
                    <SeoPreview
                      path={`/products/${draft.slug || suggestedProductSlug(draft.title)}`}
                      seoTitle={draft.seoTitle}
                      seoDescription={draft.seoDescription}
                      titleFallback={draft.title || 'Product title'}
                      descriptionFallback={richHtmlToPlainText(draft.description)}
                      emptyDescription="No description yet. Search engines will use the product page content."
                    />
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-zinc-100 bg-white px-5 py-3.5 sm:px-6">
              <button type="submit" disabled={busy || uploadPending} className={btnPrimary}>
                {busy
                  ? 'Creating...'
                  : useOptions
                    ? `Create product with ${combinationCount} variants`
                    : 'Create product'}
              </button>
            </div>
          </form>
        </DrawerContent>
      </Drawer>
      <AdminActionFeedback value={feedback} />
    </>
  );
}

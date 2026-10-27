import { useState } from 'react';
import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../../components/AdminActionFeedback';
import { useAdminAction } from '../../../components/AdminNav';
import {
  emptyProductCreateDraft,
  productCreatePayload,
  productCreateServerField,
  suggestedProductSlug,
  validateProductCreateDraft,
  type ProductCreateDraft,
  type ProductCreateErrors,
} from '../../../lib/product-create';
import {
  MAX_OPTION_GROUPS,
  MAX_VALUES_PER_GROUP,
  MAX_VARIANT_COMBINATIONS,
  countCombinations,
  generateVariantCombinations,
  validateVariantCombinations,
  type VariantCombination,
  type VariantOptionGroup,
} from '../../../lib/product-variant-options';
import {
  btnPrimary,
  btnSmall,
  cardCls,
  hintCls,
  inputCls,
  labelCls,
  pageSub,
  pageTitle,
  textareaCls,
} from '../../../components/ui';

export const Route = createFileRoute('/admin/products/new')({
  component: AdminProductNew,
});

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-xs text-red-700" role="alert">
      {message}
    </p>
  );
}

function AdminProductNew() {
  const adminAction = useAdminAction();
  const router = useRouter();
  const [draft, setDraft] = useState<ProductCreateDraft>(emptyProductCreateDraft);
  const [slugTouched, setSlugTouched] = useState(false);
  const [errors, setErrors] = useState<ProductCreateErrors>({});
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [busy, setBusy] = useState(false);
  const [useOptions, setUseOptions] = useState(false);
  const [groups, setGroups] = useState<VariantOptionGroup[]>([
    { name: 'Size', values: ['Small', 'Medium', 'Large'] },
    { name: 'Color', values: ['Black', 'White'] },
  ]);
  const [combinations, setCombinations] = useState<VariantCombination[]>([]);
  const [optionErrors, setOptionErrors] = useState<string[]>([]);
  const [resetArmed, setResetArmed] = useState(false);

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

  return (
    <main>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className={pageTitle}>Add product</h1>
          <p className={pageSub}>
            Create the product record and its first variant in one step. You can add more variants,
            images, and options on the product page next.
          </p>
        </div>
        <Link
          to="/admin/products"
          search={{ q: '', mode: null, status: 'all', sort: 'newest' }}
          className={btnSmall}
        >
          Back to products
        </Link>
      </div>
      <AdminActionFeedback value={feedback} />

      <form
        className={`${cardCls} mt-5 space-y-6 p-5 sm:p-6`}
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
          const nextOptionErrors = useOptions ? validateVariantCombinations(combinations) : [];
          setOptionErrors(nextOptionErrors);
          if (Object.values(nextErrors).some(Boolean) || nextOptionErrors.length > 0) {
            setFeedback({ kind: 'error', message: 'Fix the highlighted fields and try again.' });
            return;
          }
          setBusy(true);
          const payload = productCreatePayload(draft);
          if (useOptions) {
            payload.variants = combinations.map((combo) => ({
              sku: combo.sku.trim(),
              title: combo.title,
              priceCents: Math.round(Number(combo.price) * 100),
              stock: Number(combo.stock),
              weightGrams: draft.weightGrams.trim() === '' ? null : Number(draft.weightGrams),
              continueSelling: draft.continueSelling,
            }));
          }
          const result = await adminAction('product.create', payload);
          setBusy(false);
          if (result.ok) {
            const data = result.data as { productId?: string } | undefined;
            if (data?.productId) {
              void router.navigate({ to: '/admin/products/$id', params: { id: data.productId } });
              return;
            }
            setFeedback({ kind: 'status', message: 'Product created.' });
            void router.navigate({
              to: '/admin/products',
              search: { q: '', mode: null, status: 'all', sort: 'newest' },
            });
            return;
          }
          const field = productCreateServerField(result.error);
          if (field) setErrors({ [field]: result.error });
          setFeedback({
            kind: 'error',
            message: result.error ?? 'Product could not be created. Your entries are still here.',
          });
        }}
      >
        <section className="space-y-4">
          <h2 className="text-sm font-medium text-zinc-950">Product details</h2>
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
          <div>
            <label className={labelCls} htmlFor="new-description">
              Description
            </label>
            <textarea
              id="new-description"
              className={textareaCls}
              rows={5}
              value={draft.description}
              aria-invalid={Boolean(errors.description)}
              aria-describedby={errors.description ? 'new-description-error' : undefined}
              onChange={(event) => set('description', event.target.value)}
            />
            <FieldError id="new-description-error" message={errors.description} />
            <p className={hintCls}>
              Plain text for now. Rich descriptions arrive in a later phase.
            </p>
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
                aria-describedby={errors.slug ? 'new-slug-error' : 'new-slug-hint'}
                onChange={(event) => {
                  setSlugTouched(true);
                  set('slug', event.target.value);
                }}
              />
              <p id="new-slug-hint" className={hintCls}>
                Suggested from the title until you edit it.
              </p>
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
              <p className={hintCls}>
                Draft stays off the storefront. Active becomes eligible for the storefront as soon
                as creation completes. Publication may take a moment.
              </p>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium text-zinc-950">First variant</h2>
          <div className="grid gap-4 sm:grid-cols-2">
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
            <div>
              <label className={labelCls} htmlFor="new-variant-title">
                Variant title
              </label>
              <input
                id="new-variant-title"
                className={inputCls}
                value={draft.variantTitle}
                maxLength={200}
                aria-invalid={Boolean(errors.variantTitle)}
                aria-describedby={errors.variantTitle ? 'new-variant-title-error' : undefined}
                onChange={(event) => set('variantTitle', event.target.value)}
              />
              <FieldError id="new-variant-title-error" message={errors.variantTitle} />
            </div>
            <div>
              <label className={labelCls} htmlFor="new-price">
                Price ($)
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
            <div>
              <label className={labelCls} htmlFor="new-stock">
                Initial stock
              </label>
              <input
                id="new-stock"
                className={inputCls}
                inputMode="numeric"
                value={draft.stock}
                aria-invalid={Boolean(errors.stock)}
                aria-describedby={errors.stock ? 'new-stock-error' : undefined}
                onChange={(event) => set('stock', event.target.value)}
              />
              <FieldError id="new-stock-error" message={errors.stock} />
            </div>
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
            <label className="flex items-end gap-2 pb-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={draft.continueSelling}
                onChange={(event) => set('continueSelling', event.target.checked)}
              />
              Continue selling when out of stock
            </label>
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-zinc-950">Variant options</h2>
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={useOptions}
                onChange={(event) => {
                  setUseOptions(event.target.checked);
                  if (event.target.checked && combinations.length === 0) regenerate(groups, []);
                }}
              />
              Create variants from options
            </label>
          </div>
          {useOptions ? (
            <div className="space-y-4">
              <p className={hintCls}>
                Add option groups such as Size and Color. Every combination becomes one variant. At
                most {MAX_VARIANT_COMBINATIONS} variants can be created at once. This product
                currently makes {countCombinations(groups)} combinations.
              </p>
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
                        const next = groups.map((item, index) =>
                          index === groupIndex ? { ...item, name: event.target.value } : item
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
                      value={group.values.join(', ')}
                      onChange={(event) => {
                        const values = event.target.value
                          .split(',')
                          .map((value) => value.trim())
                          .filter(Boolean)
                          .slice(0, MAX_VALUES_PER_GROUP);
                        const next = groups.map((item, index) =>
                          index === groupIndex ? { ...item, values } : item
                        );
                        setGroups(next);
                        regenerate(next, combinations);
                      }}
                    />
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={btnSmall}
                  disabled={groups.length >= MAX_OPTION_GROUPS}
                  onClick={() => setGroups([...groups, { name: '', values: [] }])}
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
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <caption className="sr-only">Variant combinations to create</caption>
                    <thead>
                      <tr className="text-xs text-zinc-500">
                        <th className="py-1 pr-2">Variant</th>
                        <th className="py-1 pr-2">SKU</th>
                        <th className="py-1 pr-2">Price ($)</th>
                        <th className="py-1">Stock</th>
                      </tr>
                    </thead>
                    <tbody>
                      {combinations.map((combo, index) => (
                        <tr key={combo.key}>
                          <td className="py-1 pr-2">{combo.title}</td>
                          <td className="py-1 pr-2">
                            <input
                              aria-label={`SKU for ${combo.title}`}
                              className={inputCls}
                              value={combo.sku}
                              onChange={(event) =>
                                setCombinations((current) =>
                                  current.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? { ...item, sku: event.target.value }
                                      : item
                                  )
                                )
                              }
                            />
                          </td>
                          <td className="py-1 pr-2">
                            <input
                              aria-label={`Price for ${combo.title}`}
                              className={inputCls}
                              inputMode="decimal"
                              value={combo.price}
                              onChange={(event) =>
                                setCombinations((current) =>
                                  current.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? { ...item, price: event.target.value }
                                      : item
                                  )
                                )
                              }
                            />
                          </td>
                          <td className="py-1">
                            <input
                              aria-label={`Stock for ${combo.title}`}
                              className={inputCls}
                              inputMode="numeric"
                              value={combo.stock}
                              onChange={(event) =>
                                setCombinations((current) =>
                                  current.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? { ...item, stock: event.target.value }
                                      : item
                                  )
                                )
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium text-zinc-950">Search and tax</h2>
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
            <div>
              <label className={labelCls} htmlFor="new-tax">
                Tax code
              </label>
              <input
                id="new-tax"
                className={inputCls}
                value={draft.taxCode}
                maxLength={100}
                aria-invalid={Boolean(errors.taxCode)}
                aria-describedby={errors.taxCode ? 'new-tax-error' : undefined}
                onChange={(event) => set('taxCode', event.target.value)}
              />
              <FieldError id="new-tax-error" message={errors.taxCode} />
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
              aria-describedby={errors.seoDescription ? 'new-seo-description-error' : undefined}
              onChange={(event) => set('seoDescription', event.target.value)}
            />
            <FieldError id="new-seo-description-error" message={errors.seoDescription} />
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={busy} className={btnPrimary}>
            {busy ? 'Creating...' : 'Create product'}
          </button>
          <p className={hintCls}>
            One submission creates the product and first variant together. If it fails, your entries
            stay on this page.
          </p>
        </div>
      </form>
    </main>
  );
}

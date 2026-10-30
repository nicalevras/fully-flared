export type BulkVariantRow = {
  id: string;
  sku: string;
  title: string;
  price_cents: number;
};

export type BulkVariantReviewRow = {
  id: string;
  sku: string;
  title: string;
  oldPriceCents: number;
  newPriceCents: number;
};

export const MAX_BULK_VARIANTS = 50;

export function buildBulkPriceReview(
  variants: readonly BulkVariantRow[],
  selectedIds: readonly string[],
  priceCents: number | null
): { rows: BulkVariantReviewRow[]; errors: string[] } {
  const errors: string[] = [];
  if (selectedIds.length === 0) errors.push('Select at least one variant.');
  if (selectedIds.length > MAX_BULK_VARIANTS)
    errors.push(`Bulk price edits are capped at ${MAX_BULK_VARIANTS} variants at a time.`);
  const newPriceCents =
    priceCents !== null && Number.isInteger(priceCents) && priceCents >= 0 ? priceCents : null;
  if (newPriceCents === null) errors.push('Enter a price of zero or more.');
  if (errors.length > 0 || newPriceCents === null) return { rows: [], errors };
  const byId = new Map(variants.map((variant) => [variant.id, variant]));
  const rows: BulkVariantReviewRow[] = [];
  for (const id of selectedIds) {
    const variant = byId.get(id);
    if (!variant) {
      errors.push('One selected variant no longer exists. Reload before applying.');
      return { rows: [], errors };
    }
    rows.push({
      id: variant.id,
      sku: variant.sku,
      title: variant.title,
      oldPriceCents: variant.price_cents,
      newPriceCents,
    });
  }
  return { rows, errors };
}

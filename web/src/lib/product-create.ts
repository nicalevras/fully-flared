import { parseMoneyCents, slugify } from './format';

export type ProductCreateDraft = {
  title: string;
  slug: string;
  description: string;
  status: 'draft' | 'active';
  seoTitle: string;
  seoDescription: string;
  sku: string;
  variantTitle: string;
  price: string;
  compareAt: string;
  stock: string;
  weightGrams: string;
  continueSelling: boolean;
};

export type ProductCreateField = keyof ProductCreateDraft;
export type ProductCreateErrors = Partial<Record<ProductCreateField, string | undefined>>;

export const emptyProductCreateDraft: ProductCreateDraft = {
  title: '',
  slug: '',
  description: '',
  status: 'draft',
  seoTitle: '',
  seoDescription: '',
  sku: '',
  variantTitle: 'Default',
  price: '29.99',
  compareAt: '',
  stock: '0',
  weightGrams: '',
  continueSelling: false,
};

export function suggestedProductSlug(title: string): string {
  return slugify(title).slice(0, 200);
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateProductCreateDraft(draft: ProductCreateDraft): ProductCreateErrors {
  const errors: ProductCreateErrors = {};
  const title = draft.title.trim();
  if (!title) errors.title = 'Title is required.';
  else if (title.length > 300) errors.title = 'Title must be 300 characters or fewer.';
  const slug = (draft.slug.trim() || suggestedProductSlug(draft.title)).trim();
  if (!slug) errors.slug = 'Slug is required. Add a title or type a slug.';
  else if (slug.length > 200 || !SLUG_PATTERN.test(slug))
    errors.slug = 'Slug must be lowercase words joined by dashes.';
  if (draft.description.length > 20_000)
    errors.description = 'Description must be 20,000 characters or fewer.';
  if (draft.seoTitle.length > 300) errors.seoTitle = 'SEO title must be 300 characters or fewer.';
  if (draft.seoDescription.length > 500)
    errors.seoDescription = 'SEO description must be 500 characters or fewer.';
  const sku = draft.sku.trim();
  if (!sku) errors.sku = 'SKU is required.';
  else if (sku.length > 100) errors.sku = 'SKU must be 100 characters or fewer.';
  if (!draft.variantTitle.trim()) errors.variantTitle = 'Variant title is required.';
  else if (draft.variantTitle.length > 200)
    errors.variantTitle = 'Variant title must be 200 characters or fewer.';
  if (!parseMoneyCents(draft.price).ok)
    errors.price =
      'Price must be a whole amount with at most two decimal places, up to 1,000,000.00.';
  const stock = Number(draft.stock);
  if (draft.stock.trim() === '' || !Number.isInteger(stock) || stock < 0 || stock > 1_000_000)
    errors.stock = 'Stock must be a whole number from 0 to 1,000,000.';
  if (draft.weightGrams.trim() !== '') {
    const weight = Number(draft.weightGrams);
    if (!Number.isInteger(weight) || weight < 0 || weight > 1_000_000)
      errors.weightGrams = 'Weight must be a whole number of grams from 0 to 1,000,000.';
  }
  return errors;
}

export function productCreatePayload(draft: ProductCreateDraft) {
  const slug = draft.slug.trim() || suggestedProductSlug(draft.title);
  return {
    title: draft.title.trim(),
    slug,
    description: draft.description,
    status: draft.status,
    seoTitle: draft.seoTitle,
    seoDescription: draft.seoDescription,
    variants: [
      {
        sku: draft.sku.trim(),
        title: draft.variantTitle.trim(),
        priceCents: (() => {
          const parsed = parseMoneyCents(draft.price);
          return parsed.ok ? parsed.cents : 0;
        })(),
        compareAtCents: (() => {
          const parsed = parseMoneyCents(draft.compareAt);
          return draft.compareAt.trim() !== '' && parsed.ok ? parsed.cents : null;
        })(),
        stock: Number(draft.stock),
        weightGrams: draft.weightGrams.trim() === '' ? null : Number(draft.weightGrams),
        continueSelling: draft.continueSelling,
      },
    ],
  };
}

export function productCreateServerField(error: string | undefined): ProductCreateField | null {
  if (!error) return null;
  if (/slug .* already exists/i.test(error)) return 'slug';
  if (/SKU .* is already in use/i.test(error)) return 'sku';
  return null;
}

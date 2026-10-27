import { slugify } from './format';

export type ProductCreateDraft = {
  title: string;
  slug: string;
  description: string;
  status: 'draft' | 'active';
  seoTitle: string;
  seoDescription: string;
  taxCode: string;
  sku: string;
  variantTitle: string;
  price: string;
  stock: string;
  weightGrams: string;
  continueSelling: boolean;
};

export type ProductCreateField = keyof ProductCreateDraft;
export type ProductCreateErrors = Partial<Record<ProductCreateField, string>>;

export const emptyProductCreateDraft: ProductCreateDraft = {
  title: '',
  slug: '',
  description: '',
  status: 'draft',
  seoTitle: '',
  seoDescription: '',
  taxCode: '',
  sku: '',
  variantTitle: 'Default',
  price: '29.99',
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
  if (draft.taxCode.length > 100) errors.taxCode = 'Tax code must be 100 characters or fewer.';
  const sku = draft.sku.trim();
  if (!sku) errors.sku = 'SKU is required.';
  else if (sku.length > 100) errors.sku = 'SKU must be 100 characters or fewer.';
  if (!draft.variantTitle.trim()) errors.variantTitle = 'Variant title is required.';
  else if (draft.variantTitle.length > 200)
    errors.variantTitle = 'Variant title must be 200 characters or fewer.';
  const price = Number(draft.price);
  if (draft.price.trim() === '' || !Number.isFinite(price) || price < 0)
    errors.price = 'Price must be zero or more.';
  else if (Math.round(price * 100) > 100_000_000) errors.price = 'Price is too large.';
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
    taxCode: draft.taxCode,
    variants: [
      {
        sku: draft.sku.trim(),
        title: draft.variantTitle.trim(),
        priceCents: Math.round(Number(draft.price) * 100),
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

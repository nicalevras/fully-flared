import type { CartView, PricedLine, ShippingZoneView } from '@/lib/cart';
import type { StoreLimits } from '@/lib/settings-definitions';
import type { StorefrontLayoutSnapshot } from '@/server/catalog-read';

export const limits: StoreLimits = {
  checkout_email_cap: 5,
  checkout_account_cap: 10,
  checkout_ip_cap: 20,
  cart_max_qty: 99,
  cart_max_lines: 50,
  order_max_units: 500,
  checkout_session_minutes: 30,
  refund_retry_cap: 5,
  refund_stuck_minutes: 30,
};

export const zone = (
  id: string,
  countries: string[],
  freeOverCents: number | null = null
): ShippingZoneView => ({
  id,
  name: `${id} zone`,
  countries,
  rates: [
    {
      id: `${id}-rate`,
      name: `${id} standard`,
      kind: freeOverCents == null ? 'flat' : 'free_over',
      amountCents: 500,
      freeOverCents,
      perKgCents: null,
    },
  ],
});

export const line = (sku: string, overrides: Partial<PricedLine> = {}): PricedLine => ({
  sku,
  qty: 1,
  weightGrams: null,
  continueSelling: false,
  priceCents: 1000,
  productTitle: `${sku} product`,
  variantTitle: 'Default',
  available: 10,
  cover: null,
  ...overrides,
});

export const cartView = (lines: PricedLine[], zones: ShippingZoneView[]): CartView => ({
  cartId: 'cart-1',
  cartRevision: 1,
  limits,
  lines,
  zones,
  count: lines.reduce((n, l) => n + l.qty, 0),
});

export const product = (slug: string, imageCount: number) => ({
  limits,
  id: slug,
  slug,
  title: `${slug} product`,
  description: '',
  seoTitle: null,
  seoDescription: null,
  variants: [
    {
      id: `${slug}-v`,
      sku: `${slug.toUpperCase()}-1`,
      title: 'Default',
      priceCents: 1000,
      compareAtCents: null,
      status: 'active',
      continueSelling: false,
      weightGrams: null,
    },
  ],
  images: Array.from({ length: imageCount }, (_, i) => ({
    key: `${slug}-${i}`,
    publicUrl: `/img/${slug}-${i}.jpg`,
    alt: `${slug} image ${i}`,
  })),
  storeName: 'Store',
  seoTitleTemplate: '{product}',
  canonicalBaseUrl: 'https://store.test',
  currency: 'USD',
});

export const layout: StorefrontLayoutSnapshot = {
  limits,
  storeName: 'Fern & Field',
  logo: null,
  hero: null,
  announcementText: '',
  seoTitleTemplate: '{product}',
  canonicalBaseUrl: '',
  currency: 'USD',
  collections: [],
  collectionsTotal: 0,
  collectionTeasers: [],
  featured: [],
  posts: [],
};

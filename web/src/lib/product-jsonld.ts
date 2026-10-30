import { absoluteUrl } from './seo';
import { mediaUrl, type MediaSource } from './media-url';
import { richHtmlToPlainText } from './rich-text';

type JsonLdProduct = {
  slug: string;
  title: string;
  description: string;
  seoDescription: string | null;
  variants: Array<{ sku: string; priceCents: number; status: string }>;
  images: MediaSource[];
  canonicalBaseUrl: string;
  currency: string;
};

/** schema.org Product for the page head. `availability` is left out: the
 * published document carries no stock, and this head is cached HTML, so a
 * stock claim here could not match what the shopper sees (R-13, R-06). */
export function productJsonLd(product: JsonLdProduct) {
  const url = absoluteUrl(product.canonicalBaseUrl, `/products/${product.slug}`);
  const firstImage = product.images[0];
  const offers = product.variants
    .filter((v) => v.status === 'active')
    .map((v) => ({
      '@type': 'Offer',
      sku: v.sku,
      url,
      priceCurrency: product.currency,
      price: (v.priceCents / 100).toFixed(2),
    }));
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    description: product.seoDescription ?? richHtmlToPlainText(product.description),
    url,
    ...(firstImage ? { image: absoluteUrl(product.canonicalBaseUrl, mediaUrl(firstImage)) } : {}),
    ...(offers.length === 1 ? { offers: offers[0] } : offers.length > 1 ? { offers } : {}),
  };
}

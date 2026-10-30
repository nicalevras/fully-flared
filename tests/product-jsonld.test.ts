import { describe, expect, it } from 'vitest';
import { productJsonLd } from '../web/src/lib/product-jsonld';

const variant = (sku: string, priceCents: number, status = 'active') => ({
  id: sku,
  sku,
  title: sku,
  priceCents,
  compareAtCents: null,
  status,
  continueSelling: false,
  weightGrams: null,
});

const product = (variants: ReturnType<typeof variant>[]) => ({
  slug: 'tee',
  title: 'Tee',
  description: '<p>Soft tee</p>',
  seoDescription: null,
  variants,
  images: [{ key: 'tee.jpg', publicUrl: null }],
  canonicalBaseUrl: 'https://store.test',
  currency: 'EUR',
});

describe('product JSON-LD', () => {
  it('multi-variant emits one Offer per active variant with sku and no live availability', () => {
    const ld = productJsonLd(
      product([variant('TEE-S', 1500), variant('TEE-L', 1800), variant('TEE-X', 999, 'draft')])
    );
    expect(ld).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Tee',
      description: 'Soft tee',
      url: 'https://store.test/products/tee',
      image: 'https://store.test/media/tee.jpg',
    });
    expect(ld.offers).toEqual([
      {
        '@type': 'Offer',
        sku: 'TEE-S',
        url: 'https://store.test/products/tee',
        priceCurrency: 'EUR',
        price: '15.00',
      },
      {
        '@type': 'Offer',
        sku: 'TEE-L',
        url: 'https://store.test/products/tee',
        priceCurrency: 'EUR',
        price: '18.00',
      },
    ]);
    expect(JSON.stringify(ld)).not.toContain('availability');
  });

  it('a single variant emits one Offer with its sku', () => {
    expect(productJsonLd(product([variant('TEE-1', 2000)])).offers).toEqual({
      '@type': 'Offer',
      sku: 'TEE-1',
      url: 'https://store.test/products/tee',
      priceCurrency: 'EUR',
      price: '20.00',
    });
  });

  it('a product with no active variant has no offers', () => {
    expect(productJsonLd(product([variant('TEE-1', 2000, 'draft')]))).not.toHaveProperty('offers');
  });
});

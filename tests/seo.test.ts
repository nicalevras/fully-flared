import { describe, expect, it } from 'vitest';
import { absoluteUrl, jsonLd, resolveCanonicalBase, seoMeta } from '../web/src/lib/seo';

describe('SEO head builders (rendered-HTML contract)', () => {
  it('builds absolute canonical, OG, and Twitter tags from the configured base URL', () => {
    const meta = seoMeta({
      title: 'Coffee · Store',
      description: 'Dark roast.',
      url: absoluteUrl('https://shop.example.com/', '/products/coffee'),
      type: 'product',
      image: absoluteUrl('https://shop.example.com', '/media/abc.jpg'),
    });
    const byKey = Object.fromEntries(
      meta.map((m) => [m.property ?? m.name ?? 'title', m.content ?? m.title])
    );
    expect(byKey['og:url']).toBe('https://shop.example.com/products/coffee');
    expect(byKey['og:image']).toBe('https://shop.example.com/media/abc.jpg');
    expect(byKey['twitter:card']).toBe('summary_large_image');
    expect(absoluteUrl('', '/products/coffee')).toBe('/products/coffee');
  });

  it('resolves the canonical base: configured wins, else request origin', () => {
    expect(resolveCanonicalBase('https://shop.example.com/', 'https://tunnel.example.com')).toBe(
      'https://shop.example.com'
    );
    expect(resolveCanonicalBase('', 'https://tunnel.example.com')).toBe(
      'https://tunnel.example.com'
    );
    expect(resolveCanonicalBase('', '')).toBe('');
    // End to end: an empty setting must still produce an absolute canonical.
    expect(
      absoluteUrl(resolveCanonicalBase('', 'https://tunnel.example.com'), '/products/coffee')
    ).toBe('https://tunnel.example.com/products/coffee');
  });

  it('emits JSON-LD as a head script whose children parse as valid JSON', () => {
    const head = jsonLd({ '@context': 'https://schema.org', '@type': 'Product', name: 'Coffee' });
    expect(head.scripts).toHaveLength(1);
    expect(head.scripts[0]?.type).toBe('application/ld+json');
    expect(JSON.parse(head.scripts[0]?.children ?? '')).toMatchObject({
      '@type': 'Product',
      name: 'Coffee',
    });
  });
});

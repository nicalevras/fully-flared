// SEO head builders: absolute canonical/OG/Twitter URLs from the store's
// configured canonical base URL, and JSON-LD emitted through head() scripts
// (valid JSON, never escaped React text in the body).
// Effective canonical base: the configured canonical_base_url always wins;
// when it is empty, fall back to the serving request's origin (the same
// fallback api/checkout.ts, sitemap and robots already use) so canonicals
// stay absolute. Resolved server-side — head() only sees loader data.
export function resolveCanonicalBase(configured: string, fallbackOrigin: string): string {
  const base = configured || fallbackOrigin;
  return base ? base.replace(/\/$/, '') : '';
}

export function absoluteUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (!base) return path;
  const cleanBase = base.replace(/\/$/, '');
  return `${cleanBase}${path.startsWith('/') ? path : `/${path}`}`;
}

export function seoMeta(input: {
  title: string;
  description: string;
  url: string;
  type?: string;
  image?: string | undefined;
}): Array<Record<string, string>> {
  const meta: Array<Record<string, string>> = [
    { title: input.title },
    { name: 'description', content: input.description },
    { property: 'og:title', content: input.title },
    { property: 'og:description', content: input.description },
    { property: 'og:type', content: input.type ?? 'website' },
    { property: 'og:url', content: input.url },
    { name: 'twitter:card', content: input.image ? 'summary_large_image' : 'summary' },
    { name: 'twitter:title', content: input.title },
    { name: 'twitter:description', content: input.description },
  ];
  if (input.image) {
    meta.push({ property: 'og:image', content: input.image });
    meta.push({ name: 'twitter:image', content: input.image });
  }
  return meta;
}

export function jsonLd(value: Record<string, unknown>): {
  scripts: Array<{ type: string; children: string }>;
} {
  // Escape < so a title containing "</script>" cannot break out of the tag;
  // the payload still parses as identical JSON.
  return {
    scripts: [
      { type: 'application/ld+json', children: JSON.stringify(value).replace(/</g, '\\u003c') },
    ],
  };
}

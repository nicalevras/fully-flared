// Step 0 tracer gate: the product page must be server-rendered from D1 with
// complete SEO output. Requires the dev server running (npm run dev).
// Usage: node scripts/verify-tracer.mjs [baseUrl]
const base = process.argv[2] ?? 'http://localhost:8799';

const res = await fetch(`${base}/products/tracer-tee`);
if (!res.ok) throw new Error(`GET /products/tracer-tee -> ${res.status}`);
const html = await res.text();

const checks = {
  'SSR product title': /<h1\b[^>]*>Tracer Tee<\/h1>/.test(html),
  'D1-sourced body (not fallback fixture)': html.includes(
    'Seeded in D1 and SSR-rendered by TanStack Start.'
  ),
  'document title': /<title>[^<]*Tracer Tee/.test(html),
  'meta description': html.includes('name="description"'),
  'canonical link': html.includes('rel="canonical"'),
  'Open Graph title': html.includes('property="og:title"'),
  'Product JSON-LD': html.includes('application/ld+json') && html.includes('"@type":"Product"'),
};

let failed = false;
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
console.log('Tracer gate: all checks passed');

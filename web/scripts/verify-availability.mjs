// Local HTTP contract/load sample. Reads fixture IDs without changing commerce data.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { toJSONAsync, fromCrossJSON } from 'seroval';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const base = process.argv[2] ?? 'http://localhost:8800';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname))
  throw new Error('Availability verification is local-only');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folder = join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const files = readdirSync(folder).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
assert.equal(files.length, 1);
const db = new DatabaseSync(join(folder, files[0]), { readOnly: true });
const ids = db
  .prepare("SELECT id FROM products WHERE status='active' ORDER BY id LIMIT 50")
  .all()
  .map((p) => p.id);
assert.ok(ids.length, 'Seeded active products required');
const before = db
  .prepare('SELECT dirty_revision,version FROM catalog_publication WHERE id=1')
  .get();
// Resolve the compiled function ID rather than hard-coding Start's generated URL.
const moduleResponse = await fetch(base + '/src/lib/availabilityFns.ts');
const moduleText = moduleResponse.ok ? await moduleResponse.text() : '';
let functionId = moduleText.match(/createClientRpc\("([^"]+)"\)/)?.[1];
if (!functionId) {
  const assets = join(root, 'dist/server/assets');
  const manifest = readdirSync(assets).find(
    (file) => file.includes('server-fn-resolver') && file.endsWith('.js')
  );
  assert.ok(manifest, 'Build the preview before running this check');
  functionId = readFileSync(join(assets, manifest), 'utf8').match(
    /"([^"]+)":\s*\{\s*functionName:\s*"getAvailabilityFn_createServerFn_handler"/
  )?.[1];
}
assert.ok(functionId, 'Compiled availability GET server function');
const read = async (data, expectedStatus = 200) => {
  const payload = encodeURIComponent(JSON.stringify(await toJSONAsync({ data })));
  const res = await fetch(base + '/_serverFn/' + functionId + '?payload=' + payload, {
    headers: { 'x-tsr-serverfn': 'true', origin: base },
  });
  assert.equal(res.status, expectedStatus);
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.match(res.headers.get('cdn-cache-control'), /no-store/);
  if (expectedStatus !== 200) {
    await res.text();
    return;
  }
  const value = fromCrossJSON(JSON.parse(await res.text()), { refs: new Map() });
  return value.result;
};
const input = { mode: 'products', ids };
const list = await read(input);
assert.equal(list.products.length, ids.length);
const detail = await read({ mode: 'product', ids: [ids[0]] });
assert.ok(Array.isArray(detail.products[0].variants));
for (const invalid of [
  { mode: 'invalid', ids: ['x'] },
  { mode: 'product', ids: ['x', 'y'] },
  { mode: 'products', ids: Array.from({ length: 51 }, (_, i) => 'p' + i) },
])
  await read(invalid, 400);
assert.equal((await fetch(base + '/api/availability')).status, 404);
console.log(
  'PASS availability GET server function: list/detail, no-store, 400 validation and removed route 404'
);
const samples = [];
let next = 0;
const total = 100,
  concurrency = 10;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next++ < total) {
      const start = performance.now();
      await read(input);
      samples.push(performance.now() - start);
    }
  })
);
samples.sort((a, b) => a - b);
assert.equal(samples.length, total);
assert.deepEqual(
  db.prepare('SELECT dirty_revision,version FROM catalog_publication WHERE id=1').get(),
  before
);
console.log(
  `PASS availability requests=${total} concurrency=${concurrency} products=${ids.length} p50=${samples[50].toFixed(0)}ms p95=${samples[95].toFixed(0)}ms; publication unchanged`
);
console.log(
  'D1/cache query counts: behavioral tests measure cold=1, hit=0, expiry=1. HTTP timing is local only; deployed cache reuse remains pending.'
);
const sampleProduct = db.prepare('SELECT slug FROM products WHERE id=?').get(ids[0]);
const productHtml = await (
  await fetch(base + '/products/' + encodeURIComponent(sampleProduct.slug), {
    headers: { accept: 'text/html' },
  })
).text();
const structured = [
  ...productHtml.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g
  ),
].map((match) => JSON.parse(match[1]));
const productData = structured.find((value) => value['@type'] === 'Product');
assert.ok(productData);
assert.ok(!Object.hasOwn(productData.offers ?? {}, 'availability'));
console.log('PASS product JSON-LD omits inventory availability');
db.close();

// The installed Vite plugin exposes local trace inspection. This is a local
// assertion about the actual Worker request path, not a deployed-cache claim.
const htmlUrl = new URL('/?availability-verification=' + crypto.randomUUID(), base).href;
for (let i = 0; i < 2; i++) {
  const response = await fetch(htmlUrl, { headers: { accept: 'text/html' } });
  assert.equal(response.status, 200);
  await response.text();
}
await new Promise((resolve) => setTimeout(resolve, 500));
const sql = `SELECT COUNT(CASE WHEN s.name LIKE 'd1_%' THEN 1 END) d1_calls FROM spans r LEFT JOIN spans s ON s.trace_id=r.trace_id WHERE r.parent_id IS NULL AND json_extract(r.attributes,'$."url.full"')='${htmlUrl.replaceAll("'", "''")}' GROUP BY r.trace_id`;
const traceResponse = await fetch(base + '/cdn-cgi/local/explorer/api/local/observability/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sql }),
});
assert.equal(traceResponse.status, 200);
const traces = await traceResponse.json();
assert.equal(traces.success, true);
assert.equal(traces.result.rows.length, 2);
for (const row of traces.result.rows) assert.equal(row[0], 0);
console.log('PASS actual cold/warm anonymous HTML traces: D1 calls=0,0');

// Catalogue load gate: concurrent storefront reads against the dev/preview server.
// Usage: node scripts/load-test.mjs [baseUrl] [total] [concurrency]
const base = process.argv[2] ?? 'http://localhost:8799';
const total = Number(process.argv[3] ?? 200);
const concurrency = Number(process.argv[4] ?? 20);
const paths = ['/', '/products/tracer-tee', '/blog', '/sitemap.xml'];

const latencies = [];
let failures = 0;
let next = 0;

async function worker() {
  while (next < total) {
    const i = next++;
    const path = paths[i % paths.length];
    const start = performance.now();
    try {
      const res = await fetch(`${base}${path}`);
      if (!res.ok) failures++;
      await res.text();
    } catch {
      failures++;
    }
    latencies.push(performance.now() - start);
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const elapsedMs = performance.now() - started;
latencies.sort((a, b) => a - b);
const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
const rps = total / (elapsedMs / 1000);
console.log(`requests=${total} concurrency=${concurrency} failures=${failures}`);
console.log(`throughput=${rps.toFixed(1)} req/s p95=${p95.toFixed(0)}ms`);
const pass = failures === 0 && p95 < 2000;
console.log(pass ? 'PASS  load gate (local dev baseline)' : 'FAIL  load gate');
process.exit(pass ? 0 : 1);

// Public-rendering latency sample only. This script does not exercise checkout,
// provider recovery, stock invariants, sustainable throughput or deployed capacity.
// The old checkout burst used an obsolete request shape and could pass with every
// request rejected. Commerce correctness belongs to stubbed behavioral tests.
// Usage: node scripts/load-gate.mjs [baseUrl]
const base = process.argv[2] ?? 'http://localhost:8799';

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function timed(fn) {
  const t0 = performance.now();
  const result = await fn();
  return { ms: performance.now() - t0, result };
}

// Public reads: search intentionally uses D1.
{
  const paths = ['/', '/', '/products/everyday-tote', '/search?q=tote', '/articles'];
  const concurrency = 25;
  const total = 100;
  const times = [];
  let errors = 0;
  let next = 0;
  async function worker() {
    while (next < total) {
      const path = paths[next++ % paths.length];
      const { ms, result } = await timed(() => fetch(`${base}${path}`));
      times.push(ms);
      if (!result.ok) errors++;
    }
  }
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedS = (performance.now() - started) / 1000;
  times.sort((a, b) => a - b);
  const rps = total / elapsedS;
  const p95 = percentile(times, 95);
  const pass = errors === 0 && p95 < 300;
  console.log(
    `GATE catalogue: ${total} reads @ ${concurrency} concurrent in ${elapsedS.toFixed(1)}s = ${rps.toFixed(0)} req/s, p95 ${p95.toFixed(0)}ms, errors ${errors} -> ${pass ? 'PASS' : 'FAIL'} (local sample; not a production capacity gate)`
  );
  if (!pass) process.exitCode = 1;
}

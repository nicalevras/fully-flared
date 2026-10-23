import { expect, it } from 'vitest';
import { build } from '../web/node_modules/esbuild/lib/main.js';
import { resolve } from 'node:path';
import {
  Miniflare,
  convertV4MiniflareOptions,
} from '../web/node_modules/miniflare/dist/src/index.js';

// Real-DO coverage (Phase 5 gap): the controller itself — SQLite-backed
// bucket + permits inside workerd — not the fake namespace the route
// tests use. Config comes from a real D1 settings table.
async function makeAdmission(settings: Record<string, string>) {
  const bundle = await build({
    entryPoints: [resolve('web/src/do/checkout-admission.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['cloudflare:workers'],
  });
  const script =
    bundle.outputFiles[0]!.text +
    `
    export default { async fetch(request, env) {
      const stub = env.CHECKOUT_ADMISSION.getByName('store');
      const url = new URL(request.url);
      if (url.pathname === '/acquire') return Response.json(await stub.acquire());
      if (url.pathname === '/release') { await stub.release(url.searchParams.get('id')); return new Response('ok'); }
      return new Response('not found', { status: 404 });
    } };`;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'checkout-admission-do',
      compatibilityDate: '2026-10-17',
      modules: true,
      script,
      d1Databases: { DB: 'admission-test-db' },
      durableObjects: {
        CHECKOUT_ADMISSION: { className: 'CheckoutAdmissionDO', useSQLite: true },
      },
    })
  );
  const db = await mf.getD1Database('DB');
  await db
    .prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    .run()
    .catch(() => undefined);
  for (const [key, value] of Object.entries(settings))
    await db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind(key, value)
      .run();
  const call = async (path: string) => {
    const res = await mf.dispatchFetch(`http://local${path}`);
    return res.json() as Promise<{ ok: boolean; permitId?: string; retryAfterSeconds?: number }>;
  };
  return { mf, call };
}

it('enforces configured budgets in the real DO and releases idempotently', async () => {
  const { mf, call } = await makeAdmission({
    admission_starts_per_second: '100',
    admission_burst: '2',
    admission_max_active: '2',
  });
  try {
    const a = await call('/acquire');
    const b = await call('/acquire');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // Burst and max-active both reached: the next start is busy.
    const c = await call('/acquire');
    expect(c.ok).toBe(false);
    expect(c.retryAfterSeconds).toBeGreaterThan(0);
    // Release frees a slot; releasing twice is a no-op.
    await mf.dispatchFetch(`http://local/release?id=${a.permitId}`);
    await mf.dispatchFetch(`http://local/release?id=${a.permitId}`);
    const d = await call('/acquire');
    expect(d.ok).toBe(true);
  } finally {
    await mf.dispose();
  }
});

it('cold start without settings uses bounded defaults, never unlimited', async () => {
  const { mf, call } = await makeAdmission({});
  try {
    // Default burst is 10: ten instant acquires succeed, the 11th is busy.
    for (let i = 0; i < 10; i++) expect((await call('/acquire')).ok).toBe(true);
    expect((await call('/acquire')).ok).toBe(false);
  } finally {
    await mf.dispose();
  }
});

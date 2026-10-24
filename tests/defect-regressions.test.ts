import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, seedProduct } from './helpers/d1';
import { createPendingOrder } from '../web/src/server/checkout';
import { pendingIntent } from './helpers/pending-intent';

// Regression traceability for docs/DEFECTS.md. Behavioral defects have
// behavioral tests here or in their named suites; the configuration-level
// defects (single-DO storage, key split-brain, open CORS) are closed by
// construction, so they are asserted against the shipped source/config.
// (Register kept from the project's early defect audit; defect classes are
// stated generically — this suite guards the current codebase against them.)
const webSrc = join(process.cwd(), 'web', 'src');
const wrangler = readFileSync(join(process.cwd(), 'web', 'wrangler.jsonc'), 'utf8');

function allSource(): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(readFileSync(p, 'utf8'));
    }
  };
  walk(webSrc);
  return files.join('\n');
}

describe('Defect regressions (docs/DEFECTS.md)', () => {
  it('#1 commerce data lives in D1; the only Durable Object is Realtime', () => {
    expect(wrangler).toContain('"class_name": "RealtimeDO"');
    expect(wrangler).not.toMatch(/class_name": "(Store|Shop|Commerce|Merchant)/);
    expect(wrangler).toContain('d1_databases');
  });

  it('#2 Stripe keys come only from Worker secrets, never the database', () => {
    const payments = readFileSync(join(webSrc, 'server', 'payments.ts'), 'utf8');
    expect(payments).not.toMatch(/\.prepare\(|SELECT .* FROM settings/i);
    expect(payments).toMatch(/STRIPE_SECRET_KEY/);
  });

  it('#7 rate limiting is platform bindings, never a per-isolate Map', () => {
    const src = allSource();
    expect(src).not.toMatch(/new Map<[^>]*>\(\)[^;]*limit/i);
    expect(wrangler).toContain('CHECKOUT_LIMITER');
    expect(wrangler).toContain('AUTH_LIMITER');
  });

  it('#8 no open CORS anywhere in the Worker source', () => {
    const src = allSource();
    expect(src).not.toContain("Access-Control-Allow-Origin': '*'");
    expect(src).not.toContain('Access-Control-Allow-Origin": "*"');
    expect(src).not.toMatch(/allowOrigin:\s*'\*'/);
  });

  it('#9 checkout currency comes from store settings, not a hardcode', async () => {
    const { db, dispose } = await createTestDb();
    try {
      const sku = await seedProduct(db, {});
      await db
        .prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES ('currency', 'EUR', '2026-01-01T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value = 'EUR'"
        )
        .run();
      const order = await createPendingOrder(
        db,
        {
          shippingCountry: 'US',
          shippingRateId: 'test-rate',
          email: 'eur@example.com',
          lines: [{ sku, qty: 1 }],
        },
        pendingIntent()
      );
      expect(order.currency).toBe('EUR');
    } finally {
      await dispose();
    }
  }, 60_000);
});

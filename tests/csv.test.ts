import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '../web/src/server/csv';
import { createTestDb } from './helpers/d1';
import { runAdminAction } from '../web/src/server/admin-actions';
import { actionData, z } from './helpers/json';

describe('RFC 4180 CSV parser', () => {
  it('parses quoted fields with commas, quotes, and newlines', () => {
    const rows = parseCsv(
      'title,slug,sku\r\n"Coffee, Dark ""Roast""",coffee,SKU-1\n"Multi\nline",multi,SKU-2\n'
    );
    expect(rows).toEqual([
      ['title', 'slug', 'sku'],
      ['Coffee, Dark "Roast"', 'coffee', 'SKU-1'],
      ['Multi\nline', 'multi', 'SKU-2'],
    ]);
  });

  it('preserves carriage returns through a round trip', () => {
    const csv = toCsv([{ v: 'first\rsecond' }]);
    expect(parseCsv(csv)[1]).toEqual(['first\rsecond']);
  });

  it('round-trips through toCsv and neutralizes formula cells', () => {
    const csv = toCsv([{ name: 'A, B', note: '=SUM(1,2)' }]);
    expect(csv).toContain('"A, B"');
    expect(csv).toContain("'=SUM(1,2)");
    expect(parseCsv(csv)[1]).toEqual(['A, B', "'=SUM(1,2)"]);
  });

  it('tab and CR prefixes are escaped', () => {
    expect(parseCsv(toCsv([{ tab: '\t=1+2', cr: '\r=1+2' }]))[1]).toEqual(["'\t=1+2", "'\r=1+2"]);
  });
});

describe('CSV product import with per-row errors', () => {
  it('imports valid rows and reports each bad row by number', async () => {
    // 500 sequential D1 batches on Miniflare exceed the 5s default.
    const { db, env, dispose } = await createTestDb();
    try {
      const lines = ['title,slug,sku,price_cents,stock'];
      for (let i = 1; i <= 500; i++) {
        if (i % 100 === 0)
          lines.push(`,missing-${i},SKU-${i},1000,1`); // no title
        else lines.push(`"Product, ${i}",product-${i},SKU-${i},1000,2`);
      }
      const result = await runAdminAction(
        db,
        env,
        { id: 'owner-1', role: 'owner' },
        'import.productsCsv',
        { csv: lines.join('\n') }
      );
      const data = actionData(
        result,
        z.object({ imported: z.number(), errors: z.array(z.object({ row: z.number() })) })
      );
      expect(data.imported).toBe(495);
      expect(data.errors.map((e) => e.row)).toEqual([101, 201, 301, 401, 501]);
      const ledger = await db
        .prepare("SELECT COALESCE(SUM(delta_on_hand),0) AS s FROM stock_ledger WHERE sku = 'SKU-1'")
        .first<{ s: number }>();
      expect(ledger?.s).toBe(2);
    } finally {
      await dispose();
    }
  }, 60_000);
  it('rejects files over the 1,000-row cap before importing anything', async () => {
    const { db, env, dispose } = await createTestDb();
    try {
      const lines = ['title,slug,sku,price_cents,stock'];
      for (let i = 1; i <= 1001; i++) lines.push(`Product ${i},product-${i},SKU-${i},1000,1`);
      const result = await runAdminAction(
        db,
        env,
        { id: 'owner-1', role: 'owner' },
        'import.productsCsv',
        { csv: lines.join('\n') }
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain('1000');
      expect((await db.prepare('SELECT COUNT(*) AS n FROM products').first())?.n).toBe(0);
    } finally {
      await dispose();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { previewProductsCsv } from '../web/src/lib/products-csv';

describe('products CSV preview', () => {
  it('reads headers, counts rows, and previews the first rows', () => {
    const preview = previewProductsCsv(
      'title,slug,sku,price_cents,stock\n"Tote, Large",tote,TOTE-1,2999,10\nHat,hat,HAT-1,1500,3\n'
    );
    expect(preview.missingColumns).toEqual([]);
    expect(preview.totalRows).toBe(2);
    expect(preview.previewRows[0]).toEqual(['Tote, Large', 'tote', 'TOTE-1', '2999', '10']);
    expect(preview.problems).toEqual([]);
  });

  it('names missing required columns before anything is submitted', () => {
    const preview = previewProductsCsv('title,sku\nHat,HAT-1\n');
    expect(preview.missingColumns).toEqual(['slug', 'price_cents', 'stock']);
    expect(preview.problems.join(' ')).toContain('Missing required columns');
  });

  it('rejects a file past the row bound', () => {
    const body = Array.from({ length: 1001 }, (_, i) => `P${i},p${i},SKU-${i},100,1`).join('\n');
    const preview = previewProductsCsv(`title,slug,sku,price_cents,stock\n${body}\n`);
    expect(preview.problems.join(' ')).toContain('limit is 1000');
  });
});

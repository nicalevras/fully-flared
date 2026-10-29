import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

describe('admin data table sweep', () => {
  it('uses one shared shadcn Data Table on every offset-paged list', () => {
    const offsetLists = [
      'web/src/routes/admin/articles.tsx',
      'web/src/routes/admin/media.tsx',
      'web/src/routes/admin/discounts.tsx',
      'web/src/routes/admin/pages.tsx',
      'web/src/routes/admin/inventory.tsx',
      'web/src/routes/admin/customers.tsx',
    ];
    for (const file of offsetLists) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('components/ui/data-table');
      expect(source, file).toContain('<DataTable');
      expect(source, file).toContain('staleTime: 30_000');
    }
    expect(existsSync('web/src/components/AdminPager.tsx')).toBe(false);
    expect(existsSync('web/src/components/AdminPagination.tsx')).toBe(false);
    const table = readFileSync('web/src/components/ui/data-table.tsx', 'utf8');
    expect(table).toContain('DataTablePagination');
    expect(table).toContain('DataTableViewOptions');
    expect(table).toContain('manualPagination: true');
    expect(table).toContain('overflow-hidden rounded-md border');
  });
});

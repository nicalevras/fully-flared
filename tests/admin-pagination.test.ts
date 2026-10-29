import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

describe('admin pagination sweep', () => {
  it('uses one shared shadcn pager on every offset-paged list', () => {
    for (const file of [
      'web/src/routes/admin/articles.tsx',
      'web/src/routes/admin/media.tsx',
      'web/src/routes/admin/discounts.tsx',
      'web/src/routes/admin/pages.tsx',
      'web/src/routes/admin/inventory.tsx',
      'web/src/routes/admin/customers.tsx',
    ]) {
      expect(readFileSync(file, 'utf8'), file).toContain('AdminPagination');
    }
    expect(existsSync('web/src/components/AdminPager.tsx')).toBe(false);
    for (const file of [
      'web/src/routes/admin/articles.tsx',
      'web/src/routes/admin/media.tsx',
      'web/src/routes/admin/discounts.tsx',
      'web/src/routes/admin/pages.tsx',
      'web/src/routes/admin/inventory.tsx',
      'web/src/routes/admin/customers.tsx',
    ]) {
      expect(readFileSync(file, 'utf8'), file).toContain('staleTime: 30_000');
    }
    const pager = readFileSync('web/src/components/AdminPagination.tsx', 'utf8');
    expect(pager).toContain("from './ui/pagination'");
    expect(pager).toContain('PaginationLink');
    expect(pager).toContain('PaginationEllipsis');
  });
});

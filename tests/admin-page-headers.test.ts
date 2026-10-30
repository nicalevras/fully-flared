import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function adminSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return adminSources(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('uniform admin page headers', () => {
  it('routes every title through the shared 28px pageTitle token', () => {
    const ui = readFileSync('web/src/components/ui.tsx', 'utf8');
    expect(ui).toContain(
      "pageTitle = 'text-[28px] leading-tight font-medium tracking-tight text-zinc-950'"
    );
    expect(ui).toContain("pageSub = 'mt-1 text-sm text-zinc-500'");
    for (const file of adminSources('web/src/routes/admin')) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toContain('text-[28px]');
    }
    for (const file of [
      'web/src/routes/admin/index.tsx',
      'web/src/routes/admin/products/index.tsx',
      'web/src/routes/admin/collections.tsx',
      'web/src/routes/admin/discounts.tsx',
      'web/src/routes/admin/media.tsx',
      'web/src/routes/admin/inventory.tsx',
      'web/src/routes/admin/articles.tsx',
      'web/src/routes/admin/pages.tsx',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('<h1 className={pageTitle}>');
      expect(source, file).toContain('<p className={pageSub}>');
    }
  });

  it('keeps one mt-6 gap above list tables and empty states', () => {
    for (const file of [
      'web/src/routes/admin/articles.tsx',
      'web/src/routes/admin/pages.tsx',
      'web/src/routes/admin/collections.tsx',
      'web/src/routes/admin/discounts.tsx',
      'web/src/routes/admin/media.tsx',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toContain('"mt-8"');
      expect(source, file).not.toContain('mt-8 rounded');
      expect(source, file).toContain('mt-6');
    }
    const inventory = readFileSync('web/src/routes/admin/inventory.tsx', 'utf8');
    expect(inventory).not.toContain('"mt-5"');
    expect(inventory).toContain('"mt-6"');
    expect(existsSync('web/src/routes/admin/articles.tsx')).toBe(true);
  });
});

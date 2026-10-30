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
    expect(table).toContain('overflow-hidden rounded-lg border');
  });

  it('keeps the toolbar inside the wrapper with search left and actions right', () => {
    const table = readFileSync('web/src/components/ui/data-table.tsx', 'utf8');
    // Header band and footer live inside the one bordered wrapper.
    expect(table).toContain('overflow-hidden rounded-lg border border-zinc-200 bg-white');
    expect(table).toContain('[&_th]:px-3');
    expect(table).toContain('[&_td]:px-3');
    expect(table).toContain('[&_th]:py-3');
    expect(table).toContain('[&_td]:py-3');
    expect(table).toContain('flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-3');
    expect(table).not.toContain('border-b border-zinc-200 px-3 py-2.5');
    expect(table).toContain('border-t border-zinc-200');
    expect(
      table.indexOf('flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-3')
    ).toBeLessThan(table.indexOf('<Table'));
    // Two toolbar slots: left content, then a right-aligned actions cluster
    // with the Columns view-options dropdown last.
    expect(table).toContain('toolbarActions?: React.ReactNode;');
    expect(table).toContain('ml-auto flex flex-wrap items-center justify-end gap-2');
    expect(table.indexOf('{toolbarActions}')).toBeLessThan(table.indexOf('<DataTableViewOptions'));
    // Every qualifier control sits in the right-side actions slot sharing
    // one style, and the search input carries no query-type picker.
    const searchStart = table.indexOf('export function DataTableSearch');
    expect(table.slice(searchStart)).not.toContain('queryType');
    expect(table).toContain('min-w-0 grow basis-64 sm:max-w-sm');
    expect(table).toContain('flex min-w-0 flex-1 flex-wrap');
    expect(table).toContain('dataTableControlClassName');
    const products = readFileSync('web/src/routes/admin/products/index.tsx', 'utf8');
    expect(products).not.toContain('queryType={');
    expect(products).not.toContain('modeChoice');
    for (const file of [
      'web/src/routes/admin/products/index.tsx',
      'web/src/routes/admin/orders/index.tsx',
      'web/src/routes/admin/inventory.tsx',
    ]) {
      expect(readFileSync(file, 'utf8'), file).toContain('toolbarActions={');
    }
    // Filter buttons keep the Select checkmark menu but show a fixed label:
    // Radix renders SelectValue children instead of the selected item text.
    expect(products).toContain('<SelectValue>Status</SelectValue>');
    expect(products).toContain('<SelectValue>Sort</SelectValue>');
    const orders = readFileSync('web/src/routes/admin/orders/index.tsx', 'utf8');
    expect(orders).toContain('<SelectValue>View</SelectValue>');
    expect(orders).toContain('<SelectValue>Payment</SelectValue>');
    expect(readFileSync('web/src/routes/admin/inventory.tsx', 'utf8')).toContain(
      'dataTableControlClassName'
    );
    const shell = readFileSync('web/src/components/AdminDataTable.tsx', 'utf8');
    expect(shell).toContain('toolbarActions?: ReactNode;');
    expect(shell).toContain('overflow-hidden rounded-lg border border-zinc-200 bg-white');
    expect(shell).toContain('[&_th]:px-3');
    expect(shell).toContain('[&_td]:px-3');
    expect(shell).toContain('[&_th]:py-3');
    expect(shell).toContain('[&_td]:py-3');
    expect(shell).toContain('flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-3');
    expect(shell).not.toContain('border-b border-zinc-200 px-3 py-2.5');
    expect(readFileSync('web/src/routes/admin/collections.tsx', 'utf8')).toContain(
      'toolbarActions={'
    );
  });

  it('puts the New button in the table header like products', () => {
    const newButton = 'h-8 rounded-md bg-zinc-950 text-white shadow-none hover:bg-zinc-800';
    for (const file of [
      'web/src/routes/admin/articles.tsx',
      'web/src/routes/admin/pages.tsx',
      'web/src/routes/admin/discounts.tsx',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('toolbarEnd={');
      expect(source, file).toContain(newButton);
      expect(source.indexOf('toolbarEnd={'), file).toBeLessThan(source.indexOf('<PlusIcon /> New'));
    }
    const collections = readFileSync('web/src/routes/admin/collections.tsx', 'utf8');
    expect(collections).toContain(newButton);
    expect(collections.indexOf('toolbarActions={')).toBeLessThan(
      collections.indexOf('<PlusIcon /> New')
    );
    const products = readFileSync('web/src/routes/admin/products/index.tsx', 'utf8');
    expect(products.indexOf('toolbarEnd={')).toBeLessThan(products.indexOf('<PlusIcon /> New'));
  });

  it('places Status last, before the trailing actions column', () => {
    const products = readFileSync('web/src/routes/admin/products/index.tsx', 'utf8');
    expect(products.indexOf("id: 'status'")).toBeGreaterThan(products.indexOf("id: 'inventory'"));
    expect(products.indexOf("id: 'status'")).toBeLessThan(products.indexOf("id: 'actions'"));
    const articles = readFileSync('web/src/routes/admin/articles.tsx', 'utf8');
    expect(articles.indexOf("id: 'status'")).toBeGreaterThan(articles.indexOf("id: 'updated'"));
    const discounts = readFileSync('web/src/routes/admin/discounts.tsx', 'utf8');
    expect(discounts.indexOf("id: 'status'")).toBeGreaterThan(discounts.indexOf("id: 'used'"));
    expect(discounts.indexOf("id: 'status'")).toBeLessThan(discounts.indexOf("id: 'actions'"));
    const dash = readFileSync('web/src/routes/admin/index.tsx', 'utf8');
    const recent = dash.slice(dash.indexOf('Recent orders'), dash.indexOf('</Table>'));
    expect(recent.indexOf('>Status<')).toBeGreaterThan(recent.indexOf('>Payment<'));
    expect(recent.indexOf('>Status<')).toBeGreaterThan(recent.indexOf('>Total<'));
    expect(recent.indexOf('>Status<')).toBeLessThan(recent.indexOf('Open order'));
  });
});

import { describe, expect, it } from 'vitest';
import { createElement } from '../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../web/node_modules/react-dom/server.node.js';
import { DataTable, DataTableSearch } from '../web/src/components/ui/data-table';
import type { ServerDataTableProps } from '../web/src/components/ui/data-table';

type Product = { title: string; status: string };

function renderTable(overrides: Partial<ServerDataTableProps<Product>> = {}) {
  return renderToStaticMarkup(
    createElement(DataTable<Product>, {
      caption: 'Products',
      columns: [
        { accessorKey: 'title', header: 'Product' },
        { accessorKey: 'status', header: 'Status' },
      ],
      data: [],
      pageIndex: 0,
      pageSize: 50,
      rowCount: 0,
      onPaginationChange: () => undefined,
      ...overrides,
    })
  );
}

describe('empty admin tables', () => {
  it('retains table headers, search, creation controls, and a reset action at zero results', () => {
    const html = renderTable({
      toolbar: createElement(DataTableSearch, {
        value: 'missing',
        onSearch: () => undefined,
        placeholder: 'Search products',
        ariaLabel: 'Find products',
      }),
      toolbarEnd: createElement('button', { type: 'button' }, 'New'),
      emptyMessage: createElement(
        'div',
        null,
        'No matching products.',
        createElement('button', { type: 'button' }, 'Reset filters')
      ),
    });
    expect(html).toContain('<table');
    expect(html).toContain('<thead');
    expect(html.match(/<thead[\s\S]*?<\/thead>/)?.[0]).toContain('Product');
    expect(html.match(/<thead[\s\S]*?<\/thead>/)?.[0]).toContain('Status');
    expect(html).toContain('aria-label="Find products"');
    expect(html).toContain('>New</button>');
    expect(html).toContain('No matching products.');
    expect(html).toContain('>Reset filters</button>');
    expect(html).toContain('colSpan="2"');
  });

  it('spans the rendered leaf columns rather than top-level column groups', () => {
    const html = renderTable({
      columns: [
        {
          id: 'details',
          header: 'Details',
          columns: [
            { accessorKey: 'title', header: 'Product' },
            { accessorKey: 'status', header: 'Status' },
          ],
        },
      ],
    });
    expect(html).toMatch(/<td[^>]*colSpan="2"/);
    expect(html).toContain('No results.');
  });

  it('shows zero pages and disables all page controls even for a stale page index', () => {
    const html = renderTable({ pageIndex: 4 });
    expect(html).toContain('Page 0 of 0');
    for (const name of ['first', 'previous', 'next', 'last']) {
      expect(html).toMatch(
        new RegExp(`<button[^>]*disabled=""[^>]*aria-label="Go to ${name} page"`)
      );
    }
  });

  it('preserves route-owned cursor pagination without requiring a total count', () => {
    const html = renderTable({
      data: [{ title: 'Tracer Tee', status: 'active' }],
      paginationFooter: createElement('nav', null, 'Previous 50 products'),
    });
    expect(html).toContain('Tracer Tee');
    expect(html).toContain('Previous 50 products');
    expect(html).not.toContain('Page 0 of 0');
    expect(html).not.toContain('No results.');
  });
});

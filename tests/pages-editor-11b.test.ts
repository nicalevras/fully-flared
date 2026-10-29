import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Phase 11B pages list and editor split', () => {
  it('keeps the list free of the inline editor and opens pages in a sheet', () => {
    const list = readFileSync('web/src/routes/admin/pages.tsx', 'utf8');
    expect(list).not.toContain('page.save');
    expect(list).not.toContain('content_html');
    expect(list).toContain('PageEditor');
    expect(list).toContain('getPageDetail');
    expect(list).toContain('ui/data-table');
    expect(list).toContain('<DataTable');
    expect(list).toContain('LIMIT ? OFFSET ?');
    expect(list).toContain('<DataTable');
    const editor = readFileSync('web/src/components/PageEditor.tsx', 'utf8');
    expect(editor).toContain('page.save');
    expect(editor).toContain("key={form.id || 'new'}");
    expect(editor).toContain('BlogEditor');
    expect(editor).toContain('SeoPreview');
    expect(editor).toContain('Save changes');
    const shim = readFileSync('web/src/routes/admin/pages_/$id.tsx', 'utf8');
    expect(shim).toContain("to: '/admin/pages'");
    expect(shim).toContain('edit: params.id');
  });
});

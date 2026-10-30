import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Phase 11A blog list and editor split', () => {
  it('keeps the list free of the inline editor and opens posts in a drawer', () => {
    const list = readFileSync('web/src/routes/admin/articles.tsx', 'utf8');
    expect(list).not.toContain('<BlogEditor');
    expect(list).toContain('BlogPostEditor');
    expect(list).toContain('AdminActionFeedback');
    expect(list).toContain('getPostDetail');
    expect(list).toContain('detail?.id === editingId');
    expect(list).toContain('?w=${variant.width}');
    expect(list).not.toContain('lg:grid-cols-4');
    expect(list).toContain('ui/data-table');
    expect(list).toContain('<DataTable');
    expect(list).toContain('row.original.updated_at');
    expect(list).toContain('formatDate(row.original.updated_at)');
    expect(list).toContain('LIMIT ? OFFSET ?');
    expect(list).toContain('pageWindow');
    expect(list).toContain('posts_fts MATCH ?');
    expect(list).not.toContain('LIMIT 100');
    expect(list).toContain('<DataTable');
    const editor = readFileSync('web/src/components/BlogPostEditor.tsx', 'utf8');
    expect(editor).toContain('ExpandableEditor');
    const shim = readFileSync('web/src/routes/admin/blog_/$id.tsx', 'utf8');
    expect(shim).toContain("to: '/admin/articles'");
    expect(shim).toContain('edit: params.id');
  });
});

describe('editor find shortcut scope', () => {
  it('only intercepts Mod+F inside the editor or search panel', () => {
    const search = readFileSync(
      'web/src/components/tiptap-ui/search-and-replace/search-and-replace.tsx',
      'utf8'
    );
    expect(search).toContain('searchAndReplace.editor?.view.dom.contains(target)');
    expect(search).toContain('if (!inEditor && !inPanel) return;');
  });
});

describe('article editor dialog', () => {
  it('opens a pop-up dialog around the single mounted editor', () => {
    const editor = readFileSync('web/src/components/BlogPostEditor.tsx', 'utf8');
    expect(editor.match(/<ExpandableEditor/g)).toHaveLength(1);
    expect(editor).toContain("editorKey={form.id || 'new'}");
    expect(editor).not.toContain('createPortal');
    expect(editor).not.toContain('editorDialogOpen');
    expect(editor).toContain('setContentJson(json)');
    const expanded = readFileSync('web/src/components/ExpandableEditor.tsx', 'utf8');
    expect(expanded.match(/<BlogEditor/g)).toHaveLength(1);
    expect(expanded).toContain('<Dialog.Portal keepMounted>');
    expect(expanded).toContain('slot.appendChild(host)');
    expect(expanded).not.toContain('addEventListener');
    const simple = readFileSync(
      'web/src/components/tiptap-templates/simple/simple-editor.tsx',
      'utf8'
    );
    expect(simple).not.toContain('is-expanded');
    expect(simple).not.toContain('expanded?: boolean');
    const scss = readFileSync(
      'web/src/components/tiptap-templates/simple/simple-editor.scss',
      'utf8'
    );
    expect(scss).not.toContain('is-expanded');
    expect(scss).toContain('.article-editor-dialog');
    expect(scss).toContain('calc(100dvh - 14rem)');
    expect(scss).toContain('height: 24rem');
  });
});

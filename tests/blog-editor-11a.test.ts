import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Phase 11A blog list and editor split', () => {
  it('keeps the list free of the inline editor and links to a dedicated workspace', () => {
    const list = readFileSync('web/src/routes/admin/blog.tsx', 'utf8');
    expect(list).not.toContain('BlogEditor');
    expect(list).toContain('/admin/blog/$id');
    const editor = readFileSync('web/src/routes/admin/blog_/$id.tsx', 'utf8');
    expect(editor).toContain('BlogEditor');
    expect(editor).toContain('saveBlogPost');
    expect(editor).toContain('AdminActionFeedback');
  });
});

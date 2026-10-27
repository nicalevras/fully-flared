import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Phase 11B pages list and editor split', () => {
  it('keeps the list free of the inline editor and links to a dedicated workspace', () => {
    const list = readFileSync('web/src/routes/admin/pages.tsx', 'utf8');
    expect(list).not.toContain('page.save');
    expect(list).toContain('/admin/pages/$id');
    const editor = readFileSync('web/src/routes/admin/pages_/$id.tsx', 'utf8');
    expect(editor).toContain('page.save');
    expect(editor).toContain("key={page?.id ?? 'new'}");
    expect(editor).toContain('AdminActionFeedback');
  });
});

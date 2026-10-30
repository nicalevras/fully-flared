import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { runEditorSave, saveBlogPost, type BlogPostForm } from '../web/src/lib/blog-save';
import { resolveScheduledIso, utcToLocalDateTimeInput } from '../web/src/lib/format';

const form: BlogPostForm = {
  id: 'p1',
  slug: 'hello',
  title: 'Hello',
  excerpt: '',
  contentHtml: '<p>Hi</p>',
  contentJson: '{}',
  status: 'scheduled',
  seoTitle: '',
  seoDescription: '',
  tags: '',
  coverMediaId: '',
  publishedAt: '2026-11-01T01:30',
};

function fakeAction(result: { ok: boolean; error?: string; data?: unknown } = { ok: true }) {
  const calls: Array<Record<string, string>> = [];
  return {
    calls,
    action: async (_action: string, payload: Record<string, string>) => {
      calls.push(payload);
      return result;
    },
  };
}

describe('utcToLocalDateTimeInput', () => {
  it('converts UTC instants to local wall time (EDT)', () => {
    expect(utcToLocalDateTimeInput('2026-07-01T13:00:00.000Z', 'America/New_York')).toBe(
      '2026-07-01T09:00'
    );
  });

  it('formats midnight as 00, not 24', () => {
    expect(utcToLocalDateTimeInput('2026-01-01T05:00:00.000Z', 'America/New_York')).toBe(
      '2026-01-01T00:00'
    );
  });

  it('invalid input yields an empty value', () => {
    expect(utcToLocalDateTimeInput('not-a-date', 'America/New_York')).toBe('');
  });
});

describe('resolveScheduledIso', () => {
  it('preserves an unchanged scheduled timestamp through the DST repeated hour', () => {
    const loaded = { localValue: '2026-11-01T01:30', iso: '2026-11-01T06:30:00.000Z' };
    expect(resolveScheduledIso('scheduled', '2026-11-01T01:30', loaded)).toEqual({
      ok: true,
      iso: '2026-11-01T06:30:00.000Z',
    });
  });

  it('blank or invalid scheduled values are an error, not a throw', () => {
    expect(resolveScheduledIso('scheduled', '', null).ok).toBe(false);
    expect(resolveScheduledIso('scheduled', 'garbage', null).ok).toBe(false);
    expect(resolveScheduledIso('draft', '', null)).toEqual({ ok: true, iso: '' });
  });
});

describe('saveBlogPost', () => {
  it('blank scheduled date makes no server call', async () => {
    const { action, calls } = fakeAction();
    const result = await saveBlogPost(action, { ...form, publishedAt: '' }, null);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('unchanged scheduled save sends the original ISO', async () => {
    const { action, calls } = fakeAction();
    const loaded = { localValue: '2026-11-01T01:30', iso: '2026-11-01T06:30:00.000Z' };
    const result = await saveBlogPost(action, form, loaded);
    expect(result).toEqual({ ok: true, created: false, postId: 'p1' });
    expect(calls[0]?.publishedAt).toBe('2026-11-01T06:30:00.000Z');
  });

  it('creation reports created so the editor can reset', async () => {
    const { action, calls } = fakeAction();
    const result = await saveBlogPost(
      action,
      { ...form, id: '', slug: '', status: 'draft', publishedAt: '' },
      null
    );
    expect(result).toEqual({ ok: true, created: true, postId: '' });
    expect(calls[0]?.slug).toBe('hello');
  });

  it('creation returns the server postId and updatedAt', async () => {
    const { action } = fakeAction({
      ok: true,
      data: { postId: 'p9', updatedAt: '2026-07-01T00:00:00.000Z' },
    });
    const result = await saveBlogPost(
      action,
      { ...form, id: '', status: 'draft', publishedAt: '' },
      null
    );
    expect(result).toEqual({
      ok: true,
      created: true,
      postId: 'p9',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
  });

  it('a second save sends the updatedAt returned by the first', async () => {
    const { action, calls } = fakeAction({
      ok: true,
      data: { postId: 'p1', updatedAt: '2026-07-02T00:00:00.000Z' },
    });
    const first = await saveBlogPost(
      action,
      { ...form, updatedAt: '2026-07-01T00:00:00.000Z' },
      null
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await saveBlogPost(action, { ...form, updatedAt: first.updatedAt }, null);
    expect(calls[0]?.expectedUpdatedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(calls[1]?.expectedUpdatedAt).toBe('2026-07-02T00:00:00.000Z');
  });

  it('a rejected save returns the server error', async () => {
    const { action } = fakeAction({ ok: false, error: 'Nope' });
    const result = await saveBlogPost(action, { ...form, status: 'draft', publishedAt: '' }, null);
    expect(result).toEqual({ ok: false, error: 'Nope' });
  });
});

describe('runEditorSave', () => {
  it('clears saving even when the save rejects', async () => {
    const sequence: boolean[] = [];
    await expect(
      runEditorSave({
        setSaving: (v) => sequence.push(v),
        onSave: async () => {
          throw new Error('boom');
        },
      })
    ).rejects.toThrow('boom');
    expect(sequence).toEqual([true, false]);
  });

  it('clears saving after a successful save', async () => {
    const sequence: boolean[] = [];
    await runEditorSave({ setSaving: (v) => sequence.push(v), onSave: async () => {} });
    expect(sequence).toEqual([true, false]);
  });
});

describe('blog editor wiring', () => {
  it('editor remounts per post and fill uses the local conversion', () => {
    const page = readFileSync('web/src/components/BlogPostEditor.tsx', 'utf8');
    expect(page).toContain("key={post?.id ?? 'new'}");
    expect(page).toContain('utcToLocalDateTimeInput(post.published_at)');
    expect(page).not.toContain('slice(0, 16)');
    const editor = readFileSync(
      'web/src/components/tiptap-templates/simple/simple-editor.tsx',
      'utf8'
    );
    expect(editor).toContain('runEditorSave');
    const blogPage = readFileSync('web/src/components/BlogPostEditor.tsx', 'utf8');
    expect(blogPage).toContain('onSaved()');
    expect(blogPage).toContain("kind: 'status'");
  });
});

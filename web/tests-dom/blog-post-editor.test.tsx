// @vitest-environment happy-dom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AdminActionFeedbackState } from '@/components/AdminActionFeedback';
import type { BlogPostDetail } from '@/components/BlogPostEditor';
import { renderRoute } from './render-route';

const adminAction = vi.hoisted(() =>
  vi.fn<(action: string, payload: object) => Promise<{ ok: true; data: object }>>(async () => ({
    ok: true,
    data: { postId: 'p1', updatedAt: '2026-10-02T00:00:00.000Z' },
  }))
);
vi.mock('@/components/AdminNav', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/AdminNav')>()),
  useAdminAction: () => adminAction,
}));

const { BlogPostEditor } = await import('@/components/BlogPostEditor');
const { BlogEditor } = await import('@/components/BlogEditor');

afterEach(() => {
  vi.unstubAllEnvs();
  adminAction.mockClear();
});

const post = (id: string, title: string, publishedAt: string): BlogPostDetail => ({
  id,
  slug: id,
  title,
  status: 'scheduled',
  excerpt: '',
  content_html: '<p>Body</p>',
  content_json: null,
  seo_title: null,
  seo_description: null,
  published_at: publishedAt,
  cover_media_id: null,
  cover_key: null,
  cover_public_url: null,
  cover_variants_json: null,
  updated_at: '2026-10-01T00:00:00.000Z',
  tags: '',
});

const first = post('p1', 'First post', '2026-07-01T13:00:00.000Z');
const second = post('p2', 'Second post', '2026-11-02T02:30:00.000Z');

function Switcher() {
  const [current, setCurrent] = useState(first);
  return (
    <>
      <button type="button" onClick={() => setCurrent(second)}>
        Open second post
      </button>
      <BlogPostEditor post={current} onClose={() => {}} onFeedback={() => {}} onSaved={() => {}} />
    </>
  );
}

it('switching posts remounts the form', async () => {
  vi.stubEnv('TZ', 'America/New_York');
  await renderRoute(Switcher);
  const title = await screen.findByLabelText('Title');
  expect(screen.getByLabelText('Publish at')).toHaveProperty('value', '2026-07-01T09:00');

  await userEvent.type(title, ' edited');
  expect(title).toHaveProperty('value', 'First post edited');

  await userEvent.click(screen.getByRole('button', { name: 'Open second post', hidden: true }));
  expect(await screen.findByDisplayValue('Second post')).toBeTruthy();
  expect(screen.getByLabelText('Publish at')).toHaveProperty('value', '2026-11-01T21:30');
});

it('saving a post reports it and refreshes the list', async () => {
  const onFeedback = vi.fn<(feedback: AdminActionFeedbackState) => void>();
  const onSaved = vi.fn<() => void>();
  await renderRoute(() => (
    <BlogPostEditor post={first} onClose={() => {}} onFeedback={onFeedback} onSaved={onSaved} />
  ));
  expect(screen.queryByRole('button', { name: 'Save changes', hidden: true })).toBeNull();

  await userEvent.type(await screen.findByLabelText('Title'), ' edited');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes', hidden: true }));

  expect(adminAction).toHaveBeenCalledTimes(1);
  expect(adminAction).toHaveBeenCalledWith(
    'post.save',
    expect.objectContaining({
      id: 'p1',
      title: 'First post edited',
      expectedUpdatedAt: '2026-10-01T00:00:00.000Z',
    })
  );
  expect(onFeedback).toHaveBeenCalledWith({ kind: 'status', message: 'Post saved and scheduled.' });
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Save post', hidden: true })).toBeNull();
  expect(screen.queryByText(/Loading post/)).toBeNull();
});

it('the article editor save button hands over the content', async () => {
  const onSave = vi.fn<(html: string, json: string) => Promise<void>>(async () => {});
  await renderRoute(() => <BlogEditor initialHtml="<p>Hello</p>" onSave={onSave} />);

  await userEvent.click(await screen.findByRole('button', { name: 'Save post' }));

  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls[0]?.[0]).toBe('<p>Hello</p>');
  expect(await screen.findByRole('button', { name: 'Save post' })).toHaveProperty(
    'disabled',
    false
  );
});

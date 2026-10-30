// @vitest-environment happy-dom
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { BlogPostEditor, type BlogPostDetail } from '@/components/BlogPostEditor';
import { renderRoute } from './render-route';

afterEach(() => {
  vi.unstubAllEnvs();
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

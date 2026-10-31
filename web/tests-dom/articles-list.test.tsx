// @vitest-environment happy-dom
import { screen } from '@testing-library/react';
import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import { expect, it } from 'vitest';
import { renderTree } from './render-route';
import { Route as ArticlesRoute } from '@/routes/admin/articles';

it('renders advertised article cover variants and falls back to the original', async () => {
  const { component, validateSearch } = ArticlesRoute.options;
  const rootRoute = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/articles',
    ...(validateSearch ? { validateSearch } : {}),
    loader: () => ({
      posts: [
        {
          id: 'variant',
          slug: 'variant',
          title: 'With variant',
          status: 'published',
          excerpt: '',
          published_at: '2026-01-01',
          updated_at: '2026-01-01',
          cover_media_id: 'media-variant',
          cover_key: 'variant.jpg',
          cover_public_url: null,
          cover_variants_json: JSON.stringify([{ width: 320, url: '' }]),
        },
        {
          id: 'original',
          slug: 'original',
          title: 'Original only',
          status: 'draft',
          excerpt: '',
          published_at: null,
          updated_at: '2026-01-01',
          cover_media_id: 'media-original',
          cover_key: 'original.jpg',
          cover_public_url: null,
          cover_variants_json: null,
        },
      ],
      total: 2,
      page: 1,
      pageSize: 25,
      detail: null,
    }),
    ...(component ? { component } : {}),
  });
  await renderTree(rootRoute.addChildren([route]), '/admin/articles');
  const table = await screen.findByRole('table', { name: 'Articles' });
  const covers = table.querySelectorAll('img');
  expect(covers).toHaveLength(2);
  expect(covers[0]?.getAttribute('src')).toBe('/media/variant.jpg?w=320');
  expect(covers[1]?.getAttribute('src')).toBe('/media/original.jpg');
});

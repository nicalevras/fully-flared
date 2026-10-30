// @vitest-environment happy-dom
import { screen } from '@testing-library/react';
import { createRootRoute } from '@tanstack/react-router';
import { expect, it } from 'vitest';
import { Route as ProductRoute } from '@/routes/_shop.products/$slug';
import { StorefrontLayout } from '@/routes/__root';
import type { StorefrontLayoutSnapshot } from '@/server/catalog-read';
import { limits, product } from './fixtures';
import { renderPage, renderTree } from './render-route';

it('copy follows settings', async () => {
  await renderPage(ProductRoute.options.component, product('tee', 1));
  await screen.findByRole('heading', { name: 'tee product' });

  expect(screen.queryByText(/business days/)).toBeNull();
  expect(screen.queryByText(/30-day/)).toBeNull();
  expect(screen.getByRole('link', { name: 'shipping policy' }).getAttribute('href')).toBe(
    '/pages/shipping'
  );
  expect(screen.getByRole('link', { name: 'returns policy' }).getAttribute('href')).toBe(
    '/pages/returns'
  );
});

it('the footer has no fixed tagline and no admin link', async () => {
  const layout: StorefrontLayoutSnapshot = {
    limits,
    storeName: 'Fern & Field',
    logo: null,
    hero: null,
    announcementText: '',
    seoTitleTemplate: '{product}',
    canonicalBaseUrl: '',
    currency: 'USD',
    collections: [],
    collectionsTotal: 0,
    collectionTeasers: [],
    featured: [],
    posts: [],
  };
  await renderTree(createRootRoute({ loader: () => layout, component: StorefrontLayout }));
  const footer = await screen.findByRole('contentinfo');

  expect(footer.textContent).toContain('Fern & Field');
  expect(footer.textContent).not.toContain('Considered goods');
  expect(screen.queryByRole('link', { name: 'Store admin' })).toBeNull();
});

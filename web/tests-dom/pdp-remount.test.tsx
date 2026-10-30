// @vitest-environment happy-dom
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import { expect, it } from 'vitest';
import { Route as ProductRoute } from '@/routes/_shop.products/$slug';
import { product } from './fixtures';
import { renderTree } from './render-route';

const catalogue = { five: product('five', 5), two: product('two', 2) };

it('navigating from a 5-image product at index 4 to a 2-image product shows image 0', async () => {
  const { component, remountDeps } = ProductRoute.options;
  const rootRoute = createRootRoute({ loader: () => ({ currency: 'USD' }), component: Outlet });
  const productRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/products/$slug',
    loader: ({ params }) => (params.slug === 'two' ? catalogue.two : catalogue.five),
    ...(component ? { component } : {}),
    ...(remountDeps ? { remountDeps } : {}),
  });
  const { router } = await renderTree(rootRoute.addChildren([productRoute]), '/products/five');

  await userEvent.click(await screen.findByRole('radio', { name: 'View image 5' }));
  expect(screen.getByAltText('five image 4')).toBeTruthy();

  await act(() => router.navigate({ to: '/products/$slug', params: { slug: 'two' } }));
  expect(await screen.findByAltText('two image 0')).toHaveProperty(
    'src',
    expect.stringContaining('/img/two-0.jpg')
  );
});

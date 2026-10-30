// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { getRouter } from '@/router';

afterEach(cleanup);

async function hoverFor(ms: number) {
  const loader = vi.fn(() => null);
  const root = createRootRoute({
    component: () => (
      <>
        <Link to="/products/$slug" params={{ slug: 'tee' }}>
          Product
        </Link>
        <Outlet />
      </>
    ),
  });
  const product = createRoute({ getParentRoute: () => root, path: '/products/$slug', loader });
  const home = createRoute({ getParentRoute: () => root, path: '/' });
  // The app's preload options; absent ones fall back as the router does.
  const { defaultPreload = false, defaultPreloadDelay = 50 } = getRouter().options;
  const router = createRouter({
    routeTree: root.addChildren([home, product]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
    defaultPreload,
    defaultPreloadDelay,
  });
  await router.load();
  render(<RouterProvider router={router} />);
  const link = await screen.findByText('Product');
  await act(async () => {
    fireEvent.mouseEnter(link);
    await new Promise((resolve) => setTimeout(resolve, ms));
    fireEvent.mouseLeave(link);
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  return loader.mock.calls.length;
}

it('a hover shorter than the delay makes no loader call', async () => {
  expect(await hoverFor(30)).toBe(0);
});

it('a hover longer than the delay preloads the route once', async () => {
  expect(await hoverFor(200)).toBe(1);
});

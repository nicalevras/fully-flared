import { render } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRoute,
  type RouteComponent,
} from '@tanstack/react-router';

export async function renderTree(routeTree: AnyRoute, path = '/') {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return { router, ...render(<RouterProvider router={router} />) };
}

export async function renderRoute(component: RouteComponent, path = '/') {
  return renderTree(createRootRoute({ component }), path);
}

/** One page route under a root whose loader supplies the store currency. */
export async function renderPage(component: RouteComponent | undefined, loaderData: unknown) {
  const rootRoute = createRootRoute({ loader: () => ({ currency: 'USD' }), component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: '/page',
    loader: () => loaderData,
    ...(component ? { component } : {}),
  });
  return renderTree(rootRoute.addChildren([page]), '/page');
}

import { render } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
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

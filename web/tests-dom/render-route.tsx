import { render } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  type RouteComponent,
} from '@tanstack/react-router';

export async function renderRoute(component: RouteComponent, path = '/') {
  const router = createRouter({
    routeTree: createRootRoute({ component }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return { router, ...render(<RouterProvider router={router} />) };
}

import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  return createRouter({
    routeTree,
    context: {},
    scrollRestoration: true,
    // Preload a route's data when the user hovers/touches its link, so a click
    // swaps instantly instead of holding the old page on screen while loading.
    defaultPreload: 'intent',
    defaultPreloadDelay: 0,
    // Commerce data (stock, prices) goes stale fast: preloaded data is only
    // trusted for 10s, and navigations always revalidate (staleTime 0 default).
    defaultPreloadStaleTime: 10_000,
    defaultStructuralSharing: true,
    // No full-page pending spinner: the root progress bar is the single
    // loading indicator, and hover preloading makes most swaps instant.
    // (Two indicators at once read as flicker.)
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}

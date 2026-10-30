import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  return createRouter({
    routeTree,
    context: {},
    scrollRestoration: false,
    scrollRestorationBehavior: 'instant',
    // Preload a route's data when the user hovers/touches its link, so a click
    // swaps instantly instead of holding the old page on screen while loading.
    // The delay skips pointers that only pass over a link; touch preloads at once.
    defaultPreload: 'intent',
    defaultPreloadDelay: 75,
    // Commerce data (stock, prices) goes stale fast: preloaded data is only
    // trusted for 10s, and navigations always revalidate (staleTime 0 default).
    defaultPreloadStaleTime: 10_000,
    defaultStructuralSharing: true,
    // No pending component or progress bar: hover preloading makes most swaps
    // instant, and a slower navigation keeps the current page until data arrives.
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}

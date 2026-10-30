// @vitest-environment happy-dom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reloadOnStaleChunk } from '@/lib/stale-chunk-reload';

const staleChunk = () => window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));

function appAt(path: string) {
  const root = createRootRoute();
  const routes = [
    createRoute({ getParentRoute: () => root, path: '/' }),
    createRoute({ getParentRoute: () => root, path: '/b', loader: staleChunk }),
  ];
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return { router, stop: reloadOnStaleChunk(router) };
}

let assign = vi.fn();
let stops: Array<() => void> = [];
beforeEach(() => {
  assign = vi.fn();
  vi.spyOn(window.location, 'assign').mockImplementation(assign);
});
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  sessionStorage.clear();
  vi.restoreAllMocks();
});

async function open(path: string) {
  const app = appAt(path);
  stops.push(app.stop);
  await app.router.load();
  return app.router;
}

it('a stale chunk during navigation loads the target URL as a full page', async () => {
  const router = await open('/');
  await router.navigate({ to: '/b', search: { q: '1' } });
  expect(assign.mock.calls).toEqual([['/b?q=1']]);
});

it('a hover preload that hits a stale chunk does not reload', async () => {
  const router = await open('/');
  await router.preloadRoute({ to: '/b' });
  expect(assign).not.toHaveBeenCalled();
});

it('a target that still fails after its reload does not reload again', async () => {
  const router = await open('/');
  await router.navigate({ to: '/b' });
  expect(assign).toHaveBeenCalledTimes(1);

  await open('/b');
  expect(assign).toHaveBeenCalledTimes(1);
});

it('a navigation elsewhere re-arms the reload', async () => {
  const router = await open('/');
  await router.navigate({ to: '/b' });
  await router.navigate({ to: '/' });
  await router.navigate({ to: '/b' });
  expect(assign).toHaveBeenCalledTimes(2);
});

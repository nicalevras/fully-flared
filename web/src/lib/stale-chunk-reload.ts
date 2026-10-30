import type { AnyRouter } from '@tanstack/react-router';

const RELOADED = 'stale-chunk-reload';

function session<T>(use: (storage: Storage) => T): T | undefined {
  try {
    return use(window.sessionStorage);
  } catch {
    return undefined;
  }
}

/**
 * A tab still running the previous deploy can ask for chunks that deploy removed, which
 * Vite reports as `vite:preloadError`. During a navigation this loads the target as a full
 * page, so the tab picks up the current build. Preloads are not navigations and never reload.
 * The target stays recorded until a navigation elsewhere resolves, so a target that still
 * fails after its reload shows the error instead of reloading again.
 */
export function reloadOnStaleChunk(router: AnyRouter) {
  let target: string | null = null;
  const stopNavigate = router.subscribe('onBeforeNavigate', (event) => {
    target = event.toLocation.href;
  });
  const stopResolved = router.subscribe('onResolved', (event) => {
    target = null;
    const href = event.toLocation.href;
    session((storage) => {
      if (storage.getItem(RELOADED) !== href) storage.removeItem(RELOADED);
    });
  });
  const onPreloadError = () => {
    const href = target;
    if (href === null) return;
    const recorded = session((storage) => {
      if (storage.getItem(RELOADED) === href) return false;
      storage.setItem(RELOADED, href);
      return true;
    });
    if (recorded) window.location.assign(href);
  };
  window.addEventListener('vite:preloadError', onPreloadError);
  return () => {
    stopNavigate();
    stopResolved();
    window.removeEventListener('vite:preloadError', onPreloadError);
  };
}

import type { AnyRouter } from '@tanstack/react-router';

const RELOADED = 'deploy-skew-reload';

function session<T>(read: (storage: Storage) => T): T | undefined {
  try {
    return read(window.sessionStorage);
  } catch {
    return undefined;
  }
}

/** Full page load of `href`, unless the last one went to the same place. */
function reloadOnce(href: string) {
  const recorded = session((storage) => {
    if (storage.getItem(RELOADED) === href) return false;
    storage.setItem(RELOADED, href);
    return true;
  });
  if (recorded) window.location.assign(href);
}

/**
 * A tab still running the previous deploy can ask for chunks that deploy removed (Vite's
 * `vite:preloadError`) or call a server function whose input has changed (a loader error).
 * Either during a client navigation loads the target as a full page, so the server renders
 * it with the current build. Preloads and the first page load never reload. The target stays
 * recorded until a navigation elsewhere succeeds, so a target that still fails after its
 * reload shows the error instead of reloading again.
 */
export function reloadOnDeploySkew(router: AnyRouter) {
  let target: string | null = null;
  const stopNavigate = router.subscribe('onBeforeNavigate', (event) => {
    target = event.toLocation.href;
  });
  const stopResolved = router.subscribe('onResolved', (event) => {
    target = null;
    const href = event.toLocation.href;
    if (router.state.matches.some((match) => match.status === 'error')) {
      if (event.fromLocation) reloadOnce(href);
      return;
    }
    session((storage) => {
      if (storage.getItem(RELOADED) !== href) storage.removeItem(RELOADED);
    });
  });
  const onPreloadError = () => {
    if (target !== null) reloadOnce(target);
  };
  window.addEventListener('vite:preloadError', onPreloadError);
  return () => {
    stopNavigate();
    stopResolved();
    window.removeEventListener('vite:preloadError', onPreloadError);
  };
}

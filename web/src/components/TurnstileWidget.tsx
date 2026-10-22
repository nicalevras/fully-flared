import { useEffect, useRef, type MutableRefObject } from 'react';

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    }
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    __turnstileLoad?: Promise<void>;
  }
}

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (window.__turnstileLoad) return window.__turnstileLoad;
  window.__turnstileLoad = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Turnstile failed to load'));
    document.head.appendChild(script);
  });
  return window.__turnstileLoad;
}

export function TurnstileWidget({
  siteKey,
  action,
  onToken,
  resetRef,
}: {
  siteKey: string;
  action: string;
  onToken: (token: string) => void;
  resetRef?: MutableRefObject<(() => void) | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const tokenRef = useRef(onToken);
  tokenRef.current = onToken;

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          callback: (token) => tokenRef.current(token),
          'expired-callback': () => tokenRef.current(''),
          'error-callback': () => tokenRef.current(''),
        });
        if (resetRef) {
          resetRef.current = () => {
            if (widgetIdRef.current && window.turnstile)
              window.turnstile.reset(widgetIdRef.current);
          };
        }
      })
      .catch(() => tokenRef.current(''));

    return () => {
      cancelled = true;
      if (resetRef) resetRef.current = null;
      if (widgetIdRef.current && window.turnstile) window.turnstile.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
  }, [siteKey, action, resetRef]);

  if (!siteKey) return null;
  return <div ref={containerRef} className="min-h-[65px]" aria-label="Bot verification" />;
}

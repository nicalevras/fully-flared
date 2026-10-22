import { useEffect } from 'react';
import { useRouter } from '@tanstack/react-router';

/**
 * Admin realtime client: subscribes to the /ws fan-out (staff + 2FA gated
 * on the server) and invalidates router data when order/inventory/catalog
 * events arrive, so open admin pages refresh without polling. The
 * subscription survives Durable Object hibernation because topics live in
 * the socket attachment; reconnects use a bounded backoff.
 */
export function RealtimeRefresh() {
  const router = useRouter();

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let retryMs = 1_000;
    let timer: ReturnType<typeof setTimeout> | undefined;

    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${window.location.host}/ws?topics=order,inventory,catalog`);
      socket.onmessage = (msg) => {
        try {
          const parsed = JSON.parse(String(msg.data)) as { type?: string };
          if (parsed.type && parsed.type !== 'error') {
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => void router.invalidate(), 250);
          }
        } catch {
          // Non-JSON frames (including pong) need no action.
        }
      };
      socket.onclose = () => {
        if (closed) return;
        timer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      };
      socket.onopen = () => {
        retryMs = 1_000;
        // Events missed while disconnected are gone; refresh on (re)connect.
        void router.invalidate();
      };
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (refreshTimer) clearTimeout(refreshTimer);
      socket?.close();
    };
  }, [router]);

  return null;
}

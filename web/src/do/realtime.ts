import { DurableObject } from 'cloudflare:workers';

// Admin real-time fan-out. Hibernatable WebSockets; topics persist per socket
// via serializeAttachment so eviction/hibernation never loses subscriptions.
const ALLOWED_TOPICS = new Set(['order', 'inventory', 'catalog', '*']);
const MAX_TOPICS = 10;

type SocketState = { topics: string[] };

export function sanitizeTopics(input: string[]): string[] {
  const topics = input
    .map((topic) => topic.trim())
    .filter((topic) => topic.length <= 32 && ALLOWED_TOPICS.has(topic));
  return [...new Set(topics)].slice(0, MAX_TOPICS);
}

/** Topics restored from a serialized attachment after hibernation/eviction. */
export function restoreTopics(serialized: unknown): string[] {
  const state = serialized as SocketState | null;
  return sanitizeTopics(Array.isArray(state?.topics) ? state.topics : []);
}

export function shouldDeliver(topics: string[], event: string): boolean {
  const topic = event.split('.')[0] ?? '';
  return topics.includes('*') || topics.includes(topic);
}

function stateOf(ws: WebSocket): SocketState {
  try {
    return { topics: restoreTopics(ws.deserializeAttachment()) };
  } catch {
    console.warn(JSON.stringify({ event: 'realtime_attachment_failed' }));
    return { topics: [] };
  }
}

export class RealtimeDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Application-level ping/pong that does not wake a hibernated object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }
    const url = new URL(request.url);
    const topics = sanitizeTopics((url.searchParams.get('topics') ?? 'order,inventory').split(','));
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ topics } satisfies SocketState);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      if (text.length > 4096) throw new Error('Message too large');
      const data = JSON.parse(text) as { action?: string; topic?: string };
      const state = stateOf(ws);
      if (data.action === 'subscribe' && data.topic) {
        state.topics = sanitizeTopics([...state.topics, data.topic]);
      } else if (data.action === 'unsubscribe' && data.topic) {
        state.topics = state.topics.filter((topic) => topic !== data.topic);
      } else {
        throw new Error('Unknown action');
      }
      // Capped, deduplicated topics keep the attachment far below the 16 KB
      // serialized-attachment limit across hibernation.
      ws.serializeAttachment(state);
    } catch {
      console.warn(JSON.stringify({ event: 'realtime_message_rejected' }));
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid subscription message' }));
      } catch {
        console.warn(JSON.stringify({ event: 'realtime_error_response_failed' }));
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    console.log(JSON.stringify({ event: 'realtime_close', code, wasClean }));
    try {
      ws.close(code, reason);
    } catch {
      console.warn(JSON.stringify({ event: 'realtime_close_failed' }));
    }
  }

  override async webSocketError(ws: WebSocket, _error: unknown) {
    console.error(
      JSON.stringify({
        event: 'realtime_error',
      })
    );
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      console.warn(JSON.stringify({ event: 'realtime_error_close_failed' }));
    }
  }

  async broadcast(event: string, payload: Record<string, unknown>) {
    const message = JSON.stringify({
      type: event,
      data: payload,
      timestamp: new Date().toISOString(),
    });
    for (const ws of this.ctx.getWebSockets()) {
      const state = stateOf(ws);
      if (shouldDeliver(state.topics, event)) {
        try {
          ws.send(message);
        } catch {
          console.warn(JSON.stringify({ event: 'realtime_broadcast_send_failed' }));
        }
      }
    }
  }
}

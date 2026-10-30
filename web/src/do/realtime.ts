import * as z from 'zod';
import { DurableObject } from 'cloudflare:workers';
import { STAFF_SESSION_HEADER } from './staff-session-header';

// Admin real-time fan-out. Hibernatable WebSockets; topics persist per socket
// via serializeAttachment so eviction/hibernation never loses subscriptions.
const ALLOWED_TOPICS = new Set(['order', 'inventory', 'catalog', '*']);
const MAX_TOPICS = 10;

type SocketState = { topics: string[]; sessionId: string };
const attachmentTopicsSchema = z.object({ topics: z.array(z.string()) });
const socketMessageSchema = z.object({
  action: z.string().optional(),
  topic: z.string().optional(),
});

export function sanitizeTopics(input: string[]): string[] {
  const topics = input
    .map((topic) => topic.trim())
    .filter((topic) => topic.length <= 32 && ALLOWED_TOPICS.has(topic));
  return [...new Set(topics)].slice(0, MAX_TOPICS);
}

/** Topics restored from a serialized attachment after hibernation/eviction. */
export function restoreTopics(serialized: unknown): string[] {
  return sanitizeTopics(attachmentTopicsSchema.safeParse(serialized).data?.topics ?? []);
}

export function shouldDeliver(topics: string[], event: string): boolean {
  const topic = event.split('.')[0] ?? '';
  return topics.includes('*') || topics.includes(topic);
}

function sessionIdOf(serialized: unknown): string {
  return serialized &&
    typeof serialized === 'object' &&
    'sessionId' in serialized &&
    typeof serialized.sessionId === 'string'
    ? serialized.sessionId
    : '';
}

function stateOf(ws: RealtimeSocket): SocketState {
  try {
    const serialized: unknown = ws.deserializeAttachment();
    return { topics: restoreTopics(serialized), sessionId: sessionIdOf(serialized) };
  } catch {
    console.warn(JSON.stringify({ event: 'realtime_attachment_failed' }));
    return { topics: [], sessionId: '' };
  }
}

/** Sessions that may still receive admin events: unexpired, 2FA-marked,
 *  and owned by an unbanned staff user. */
async function liveStaffSessions(db: D1Database, sessionIds: string[]): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const rows = await db
    .prepare(
      `SELECT s.id FROM session s
       JOIN user u ON u.id = s.user_id
       JOIN staff_two_factor_sessions m ON m.session_id = s.id
       WHERE s.id IN (SELECT value FROM json_each(?)) AND s.expires_at > ?
         AND u.role IN ('owner','admin','manager','support','warehouse')
         AND u.banned = 0 AND u.two_factor_enabled = 1`
    )
    .bind(JSON.stringify(sessionIds), Date.now())
    .all<{ id: string }>();
  return new Set(rows.results.map((row) => row.id));
}

/** The socket operations the handlers below use; a hibernatable WebSocket satisfies it. */
export type RealtimeSocket = Pick<
  WebSocket,
  'send' | 'close' | 'serializeAttachment' | 'deserializeAttachment'
>;

export async function onSocketMessage(ws: RealtimeSocket, message: string | ArrayBuffer) {
  try {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (text.length > 4096) throw new Error('Message too large');
    const data = socketMessageSchema.parse(JSON.parse(text));
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

export async function onSocketClose(
  ws: RealtimeSocket,
  code: number,
  reason: string,
  wasClean: boolean
) {
  if (!wasClean) console.warn(JSON.stringify({ event: 'realtime_close_unclean', code }));
  try {
    ws.close(code, reason);
  } catch {
    console.warn(JSON.stringify({ event: 'realtime_close_failed' }));
  }
}

export async function onSocketError(ws: RealtimeSocket) {
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

/** Sends the event to every live staff socket subscribed to its topic and
 *  closes sockets whose session has ended. */
export async function broadcastToSockets(
  db: D1Database,
  connected: RealtimeSocket[],
  event: string,
  payload: Record<string, unknown>
) {
  const message = JSON.stringify({
    type: event,
    data: payload,
    timestamp: new Date().toISOString(),
  });
  const sockets = connected.map((ws) => ({ ws, state: stateOf(ws) }));
  const live = await liveStaffSessions(db, [
    ...new Set(sockets.map(({ state }) => state.sessionId).filter(Boolean)),
  ]);
  for (const { ws, state } of sockets) {
    if (!live.has(state.sessionId)) {
      try {
        ws.close(1008, 'Session ended');
      } catch {
        console.warn(JSON.stringify({ event: 'realtime_revoked_close_failed' }));
      }
      continue;
    }
    if (shouldDeliver(state.topics, event)) {
      try {
        ws.send(message);
      } catch {
        console.warn(JSON.stringify({ event: 'realtime_broadcast_send_failed' }));
      }
    }
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
    const sessionId = request.headers.get(STAFF_SESSION_HEADER);
    if (!sessionId) return new Response('Staff session required', { status: 403 });
    const pair = new WebSocketPair();
    const { 0: client, 1: server } = pair;
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ topics, sessionId } satisfies SocketState);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    return onSocketMessage(ws, message);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    return onSocketClose(ws, code, reason, wasClean);
  }

  override async webSocketError(ws: WebSocket, _error: unknown) {
    return onSocketError(ws);
  }

  async broadcast(event: string, payload: Record<string, unknown>) {
    return broadcastToSockets(this.env.DB, this.ctx.getWebSockets(), event, payload);
  }
}

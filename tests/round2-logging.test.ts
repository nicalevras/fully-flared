import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { readListingPage } from '../web/src/server/catalog-read';
import { getStorefrontLayout } from '../web/src/server/catalog-read';
import { ALL_LISTING } from '../web/src/server/catalog-models';
import { RealtimeDO } from '../web/src/do/realtime';
import { drainOutbox } from '../web/src/server/email';
import { createPendingOrder, reprocessStaleInbox } from '../web/src/server/checkout';
import { attachStripeSession } from './helpers/attach-session';
import { discountNetworkIdentity } from '../web/src/lib/shopFns';
let db: D1Database, dispose: () => Promise<void>;
beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  await seedProduct(db);
});
afterAll(async () => dispose());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const sensitive = 'private@example.test secret-token';
it('logs KV fallback without exposing exception contents', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const result = await readListingPage(
    db,
    {
      get: async () => {
        throw new Error(sensitive);
      },
    } as never,
    ALL_LISTING,
    1
  );
  // No D1 listing payload exists yet in this fixture either, so the
  // reader reports null after logging the KV failure (never raw text).
  expect(result).toBeNull();
  expect(warn).toHaveBeenCalled();
  await getStorefrontLayout(db, {
    CATALOG_KV: {
      get: async () => {
        throw new Error(sensitive);
      },
    } as never,
  });
  expect(warn.mock.calls.length).toBe(2);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitive);
});
it('logs outbox and webhook retry failures and missing request context without PII', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await db
    .prepare(
      "INSERT INTO outbox(id,type,payload_json,created_at) VALUES('poison-mail','email.send',?,?)"
    )
    .bind(JSON.stringify({ private: sensitive }), new Date().toISOString())
    .run();
  expect(await drainOutbox(db)).toBe(0);
  const order = await createPendingOrder(db, {
    email: 'fixture@example.test',
    shippingCountry: 'US',
    shippingRateId: 'test-rate',
    lines: [{ sku: 'TEE-1', qty: 1 }],
  });
  await attachStripeSession(db, order.orderId, 'cs_log');
  const payload = JSON.stringify({
    id: 'evt_log',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_log',
        payment_status: 'paid',
        payment_intent: 'pi_log',
        amount_total: order.totalCents,
        currency: 'eur',
      },
    },
  });
  await db
    .prepare(
      "INSERT INTO webhook_inbox(id,provider,event_id,type,payload_json,received_at) VALUES('log-inbox','stripe','evt_log','checkout.session.completed',?,?)"
    )
    .bind(payload, new Date(Date.now() - 10 * 60000).toISOString())
    .run();
  await reprocessStaleInbox(db, null);
  expect(discountNetworkIdentity()).toBe('unknown');
  const events = warn.mock.calls.map(([line]) => JSON.parse(line).event);
  expect(events).toEqual(
    expect.arrayContaining([
      'outbox_drain_failed',
      'webhook_retry_failed',
      'discount_request_context_unavailable',
    ])
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitive);
});
it('records failed WebSocket operations without message, close reason or exception data', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('WebSocketRequestResponsePair', class {});
  const ws = {
    send: () => {
      throw new Error(sensitive);
    },
    close: () => {
      throw new Error(sensitive);
    },
    deserializeAttachment: () => ({ topics: ['order'] }),
  } as unknown as WebSocket;
  const object = new RealtimeDO(
    { setWebSocketAutoResponse() {}, getWebSockets: () => [ws] } as never,
    {} as never
  );
  await object.webSocketMessage(ws, sensitive);
  await object.webSocketClose(ws, 1000, sensitive, true);
  await object.webSocketError(ws, new Error(sensitive));
  await object.broadcast('order.paid', { private: sensitive });
  expect(warn.mock.calls.length).toBeGreaterThanOrEqual(4);
  for (const spy of [warn, log, error])
    expect(JSON.stringify(spy.mock.calls)).not.toContain(sensitive);
});

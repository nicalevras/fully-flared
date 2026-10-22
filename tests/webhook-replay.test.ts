import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { env } from './helpers/cloudflare-workers-stub';
import { runAdminAction } from '../web/src/server/admin-actions';
import { processInboxEvent } from '../web/src/server/checkout';

// Phase 6 guarded staff replay: owner/admin re-enqueue a quarantined
// webhook under its original event identity; support/manager cannot,
// processed events refuse, and a queue failure leaves the event
// quarantined for automatic recovery.
const provider = {
  retrieveRefund: async (id: string) => ({ id, status: 'succeeded' }),
};

let db: D1Database, dispose: () => Promise<void>;
let queue: Array<Record<string, unknown>> = [];
beforeEach(async () => {
  ({ db, dispose } = await createTestDb());
  queue = [];
  env.DB = db;
  env.JOBS = {
    send: async (msg: Record<string, unknown>) => {
      queue.push(msg);
    },
  };
  env.NOTIFICATIONS = env.JOBS;
  env.CATALOG_JOBS = env.JOBS;
});
afterEach(async () => {
  delete env.DB;
  delete env.JOBS;
  delete env.NOTIFICATIONS;
  delete env.CATALOG_JOBS;
  await dispose();
});

async function seedDeadRefundEvent(eventId = 'evt_replay_1') {
  await db
    .prepare(
      "INSERT INTO orders(id,number,customer_email,subtotal_cents,total_cents,status,payment_status,stripe_payment_intent_id,created_at,updated_at) VALUES('o','o','fixture@example.invalid',1000,1000,'paid','paid','pi_1','2026','2026')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO refunds(id,request_id,order_id,stripe_refund_id,amount_cents,purpose,status,created_at) VALUES('rf','rf','o','re_1',100,'staff','pending','2026')"
    )
    .run();
  const payload = JSON.stringify({
    id: eventId,
    type: 'refund.updated',
    data: { object: { id: 're_1', payment_intent: 'pi_1', amount: 100, status: 'pending' } },
  });
  await db
    .prepare(
      "INSERT INTO webhook_inbox(id,event_id,type,payload_json,status,attempts,received_at) VALUES(?, ?, 'refund.updated', ?, 'dead', 5, '2026-09-01T00:00:00.000Z')"
    )
    .bind(`inbox_${eventId}`, eventId, payload)
    .run();
}

it('rejects unprivileged roles, unknown and processed events', async () => {
  await seedDeadRefundEvent();
  const support = await runAdminAction(
    db,
    env as never,
    { id: 's1', role: 'support' },
    'webhook.replay',
    {
      eventId: 'evt_replay_1',
    }
  );
  expect(support.ok).toBe(false);
  const manager = await runAdminAction(
    db,
    env as never,
    { id: 's2', role: 'manager' },
    'webhook.replay',
    {
      eventId: 'evt_replay_1',
    }
  );
  expect(manager.ok).toBe(false);
  const owner = { id: 's3', role: 'owner' };
  expect(
    (await runAdminAction(db, env as never, owner, 'webhook.replay', { eventId: 'evt_missing' }))
      .status
  ).toBe(404);
  await db
    .prepare("UPDATE webhook_inbox SET status = 'processed' WHERE event_id = 'evt_replay_1'")
    .run();
  expect(
    (await runAdminAction(db, env as never, owner, 'webhook.replay', { eventId: 'evt_replay_1' }))
      .status
  ).toBe(409);
  expect(queue).toHaveLength(0);
});

it('replays a dead event exactly once and audits the action', async () => {
  await seedDeadRefundEvent();
  const owner = { id: 's3', role: 'owner' };
  const replayed = await runAdminAction(db, env as never, owner, 'webhook.replay', {
    eventId: 'evt_replay_1',
  });
  expect(replayed.ok).toBe(true);
  expect(queue).toHaveLength(1);
  expect(queue[0]).toMatchObject({ type: 'webhook.process', eventId: 'evt_replay_1' });

  await processInboxEvent(db, 'evt_replay_1', provider as never);
  await processInboxEvent(db, 'evt_replay_1', provider as never);
  const refund = await db
    .prepare("SELECT status FROM refunds WHERE id = 'rf'")
    .first<{ status: string }>();
  expect(refund?.status).toBe('succeeded');
  const inbox = await db
    .prepare("SELECT status FROM webhook_inbox WHERE event_id = 'evt_replay_1'")
    .first<{ status: string }>();
  expect(inbox?.status).toBe('processed');
  const audit = await db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'webhook.replay'")
    .first<{ n: number }>();
  expect(audit?.n).toBe(1);
});

it('queue failure leaves the event quarantined; a later replay recovers it', async () => {
  await seedDeadRefundEvent();
  const owner = { id: 's3', role: 'owner' };
  env.JOBS = {
    send: async () => {
      throw new Error('queue unavailable');
    },
  };
  const failed = await runAdminAction(db, env as never, owner, 'webhook.replay', {
    eventId: 'evt_replay_1',
  });
  expect(failed.ok).toBe(false);
  expect(failed.status).toBe(503);
  const still = await db
    .prepare("SELECT status FROM webhook_inbox WHERE event_id = 'evt_replay_1'")
    .first<{ status: string }>();
  expect(still?.status).toBe('dead');

  env.JOBS = {
    send: async (msg: Record<string, unknown>) => {
      queue.push(msg);
    },
  };
  expect(
    (await runAdminAction(db, env as never, owner, 'webhook.replay', { eventId: 'evt_replay_1' }))
      .ok
  ).toBe(true);
  await processInboxEvent(db, 'evt_replay_1', provider as never);
  const refund = await db
    .prepare("SELECT status FROM refunds WHERE id = 'rf'")
    .first<{ status: string }>();
  expect(refund?.status).toBe('succeeded');
});

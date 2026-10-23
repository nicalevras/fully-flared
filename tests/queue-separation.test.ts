import { expect, it, vi } from 'vitest';

// Phase 5 queue separation: each message type lands on its own queue,
// realtime broadcasts bypass queues entirely, and the shared schema
// is the single source of message shapes.

const sends = {
  JOBS: vi.fn(async () => {}),
  NOTIFICATIONS: vi.fn(async () => {}),
  CATALOG_JOBS: vi.fn(async () => {}),
};
const broadcast = vi.fn(async () => {});
const workerEnv = {
  JOBS: { send: sends.JOBS },
  NOTIFICATIONS: { send: sends.NOTIFICATIONS },
  CATALOG_JOBS: { send: sends.CATALOG_JOBS },
  REALTIME: { getByName: () => ({ broadcast }) },
};
vi.mock('../web/src/server/env', () => ({ workerEnv }));

import { enqueueJob } from '../web/src/server/email';
import { broadcastAdminRealtime } from '../web/src/server/realtime';
import { jobMessageSchema } from '../web/src/schemas/queue';

it('routes each message type to its separated queue', async () => {
  await enqueueJob({ type: 'webhook.process', eventId: 'evt_1' });
  expect(sends.JOBS).toHaveBeenCalledWith({ type: 'webhook.process', eventId: 'evt_1' });
  await enqueueJob({ type: 'email.send', outboxId: 'o1' });
  expect(sends.NOTIFICATIONS).toHaveBeenCalledTimes(1);
  await enqueueJob({ type: 'catalog.rebuild' });
  expect(sends.CATALOG_JOBS).toHaveBeenCalledTimes(1);
  expect(sends.JOBS).toHaveBeenCalledTimes(1);
});

it('reports a missing queue binding instead of throwing', async () => {
  const saved = workerEnv.NOTIFICATIONS;
  // @ts-expect-error simulate an unconfigured binding
  workerEnv.NOTIFICATIONS = undefined;
  try {
    expect(await enqueueJob({ type: 'email.send', outboxId: 'o3' })).toBe(false);
  } finally {
    workerEnv.NOTIFICATIONS = saved;
  }
});

it('refuses generic maintenance routing without sending to any queue', async () => {
  const counts = Object.values(sends).map((send) => send.mock.calls.length);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await enqueueJob({ type: 'maintenance.run', runId: 'outbox-run' })).toBe(false);
    expect(Object.values(sends).map((send) => send.mock.calls.length)).toEqual(counts);
    expect(log).toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it('broadcasts go straight to the RealtimeDO and failures are swallowed', async () => {
  await broadcastAdminRealtime('order.paid', { sessionId: 'cs_1' });
  expect(broadcast).toHaveBeenCalledWith('order.paid', { sessionId: 'cs_1' });
  broadcast.mockRejectedValueOnce(new Error('do unavailable'));
  await expect(broadcastAdminRealtime('order.paid', {})).resolves.toBeUndefined();
});

it('the shared schema no longer carries removed variants', () => {
  expect(
    jobMessageSchema.safeParse({ type: 'realtime.broadcast', event: 'x', payload: {} }).success
  ).toBe(false);
  // Obsolete aliases with no producers were removed, not just deprecated.
  expect(jobMessageSchema.safeParse({ type: 'catalog.product', slug: 'tee' }).success).toBe(false);
  expect(jobMessageSchema.safeParse({ type: 'notification.send', outboxId: 'o' }).success).toBe(
    false
  );
  expect(jobMessageSchema.safeParse({ type: 'webhook.process', eventId: 'e' }).success).toBe(true);
});

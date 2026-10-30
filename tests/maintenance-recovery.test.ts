import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/d1';
import { wakeDueMaintenance, runMaintenance } from '../web/src/server/maintenance';
import { enqueueOutboxRecoveryPage } from '../web/src/server/email';
import { recoveryContext } from '../web/src/server/recovery-eligibility';
import { workerEnv, type WorkerEnv } from '../web/src/server/env';
import { fakeQueue, messageBatch, queueMessage } from './helpers/queue';
import { at } from './helpers/fixtures';
import { z } from './helpers/json';
import { gatewayContext } from './helpers/gateway';

const outboxJob = z.object({ outboxId: z.string() });

let db: D1Database, dispose: () => Promise<void>;
const jobs = vi.fn<(body: unknown) => Promise<void>>(),
  mail = vi.fn<(body: unknown) => Promise<void>>(),
  catalog = vi.fn<(body: unknown) => Promise<void>>();
let env: WorkerEnv;
beforeEach(async () => {
  let bindings: Env;
  ({ db, env: bindings, dispose } = await createTestDb());
  jobs.mockReset();
  mail.mockReset();
  catalog.mockReset();
  env = {
    ...bindings,
    JOBS: fakeQueue(jobs),
    NOTIFICATIONS: fakeQueue(mail),
    CATALOG_JOBS: fakeQueue(catalog),
  };
  workerEnv.NOTIFICATIONS = env.NOTIFICATIONS;
});
afterEach(async () => {
  Reflect.deleteProperty(workerEnv, 'NOTIFICATIONS');
  vi.restoreAllMocks();
  await dispose();
});

async function email(id: string, time = '2026-01-01T00:00:00.000Z') {
  await db
    .prepare('INSERT INTO outbox(id,type,payload_json,created_at) VALUES(?,?,?,?)')
    .bind(id, 'email.send', '{}', time)
    .run();
}

it('an idle watchdog creates zero runs and sends zero messages', async () => {
  expect(await wakeDueMaintenance(env)).toEqual({ queued: 0, failed: 0 });
  expect((await db.prepare('SELECT COUNT(*) n FROM maintenance_runs').first())?.n).toBe(0);
  expect(jobs).not.toHaveBeenCalled();
  expect(mail).not.toHaveBeenCalled();
  expect(catalog).not.toHaveBeenCalled();
});

it('dispatches outbox recovery to notifications and respects future retries and active claims', async () => {
  await email('due');
  expect((await wakeDueMaintenance(env)).queued).toBe(1);
  expect(mail).toHaveBeenCalledTimes(1);
  expect(jobs).not.toHaveBeenCalled();
  await db
    .prepare('UPDATE maintenance_runs SET next_at=?')
    .bind(new Date(Date.now() + 600000).toISOString())
    .run();
  expect((await wakeDueMaintenance(env)).queued).toBe(0);
  await db
    .prepare('UPDATE maintenance_runs SET next_at=?,claim_expires_at=?')
    .bind('2026-01-01', new Date(Date.now() + 600000).toISOString())
    .run();
  expect((await wakeDueMaintenance(env)).queued).toBe(0);
  expect(mail).toHaveBeenCalledTimes(1);
});

it('one queue failure leaves durable work without blocking another family', async () => {
  await email('due');
  await db
    .prepare(
      `INSERT INTO webhook_inbox(id,event_id,type,payload_json,status,received_at,retry_after)
    VALUES('dead-event','dead-event','unsupported','{}','dead','2026-01-01','2026-01-01')`
    )
    .run();
  jobs.mockRejectedValue(new Error('queue unavailable'));
  const result = await wakeDueMaintenance(env);
  expect(result).toEqual({ queued: 1, failed: 1 });
  expect(mail).toHaveBeenCalledTimes(1);
  expect((await db.prepare('SELECT COUNT(*) n FROM maintenance_runs').first())?.n).toBe(2);
});

it('outbox pages stop at the cutoff and resume the failed position without sending mail', async () => {
  for (let i = 0; i < 28; i++) await email(`mail-${String(i).padStart(2, '0')}`);
  await email('future', '2999-01-01');
  const context = await recoveryContext(db);
  const first = await enqueueOutboxRecoveryPage(db, context);
  expect(first.queued).toBe(25);
  expect(first.done).toBe(false);
  mail.mockRejectedValueOnce(new Error('queue failure'));
  const failed = await enqueueOutboxRecoveryPage(db, context, first.cursor);
  expect(failed).toMatchObject({ queued: 0, done: false, retry: true, cursor: first.cursor });
  const last = await enqueueOutboxRecoveryPage(db, context, failed.cursor);
  expect(last).toMatchObject({ queued: 3, done: true, retry: false });
  expect(mail.mock.calls.map(([job]) => outboxJob.parse(job).outboxId)).not.toContain('future');
  expect(
    (await db.prepare("SELECT COUNT(*) n FROM outbox WHERE status='pending'").first())?.n
  ).toBe(29);
});

it('a legacy financial run discovers due work without recreating the seven-way fan-out', async () => {
  await email('due');
  await db
    .prepare(
      `INSERT INTO maintenance_runs(id,task,cutoff,next_at,started_at,updated_at)
    VALUES('legacy','financial',?,?,?,?)`
    )
    .bind(...Array(4).fill(new Date().toISOString()))
    .run();
  await runMaintenance(env, 'legacy');
  const rows = await db.prepare('SELECT task,state FROM maintenance_runs ORDER BY task').all();
  expect(rows.results).toEqual([
    { task: 'financial', state: 'done' },
    { task: 'outbox-recovery', state: 'pending' },
  ]);
  expect(mail).toHaveBeenCalledTimes(1);
  expect(jobs).not.toHaveBeenCalled();
});

it('misrouted email and outbox maintenance are forwarded before ack and never executed financially', async () => {
  const { default: worker } = await import('../web/src/server');
  await db
    .prepare(
      `INSERT INTO maintenance_runs(id,task,cutoff,next_at,started_at,updated_at)
    VALUES('outbox-run','outbox-recovery',?,?,?,?)`
    )
    .bind(...Array(4).fill('2026-01-01'))
    .run();
  const messages = [
    { type: 'email.send', outboxId: 'missing' },
    { type: 'maintenance.run', runId: 'outbox-run' },
  ];
  const ack = vi.fn(),
    retry = vi.fn();
  await worker.queue(
    messageBatch(
      env.QUEUE_NAMES.JOBS,
      messages.map((body) => queueMessage(body, { ack, retry }))
    ),
    env,
    gatewayContext()
  );
  expect(mail).toHaveBeenCalledTimes(2);
  expect(ack).toHaveBeenCalledTimes(2);
  expect(retry).not.toHaveBeenCalled();
  expect(
    (await db.prepare("SELECT state FROM maintenance_runs WHERE id='outbox-run'").first())?.state
  ).toBe('pending');
  mail.mockRejectedValueOnce(new Error('forward failed'));
  await worker.queue(
    messageBatch(env.QUEUE_NAMES.JOBS, [queueMessage(at(messages, 0), { ack, retry })]),
    env,
    gatewayContext()
  );
  expect(ack).toHaveBeenCalledTimes(2);
  expect(retry).toHaveBeenCalledTimes(1);
});

import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { enqueueOutboxRecoveryPage, processOutboxRow } from '../web/src/server/email';
import { failedEmailCount } from '../web/src/server/outbox';
import { recoveryContext } from '../web/src/server/recovery-eligibility';
import { pruneRetention } from '../web/src/server/operations';

let db: D1Database, dispose: () => Promise<void>;

const payload = JSON.stringify({
  to: 'c@example.com',
  subject: 'Receipt',
  text: 'hi',
  html: '<p>hi</p>',
});

async function failedRow(id: string, attempts: number, createdAt = new Date().toISOString()) {
  await db
    .prepare(
      `INSERT INTO outbox (id, type, payload_json, status, attempts, created_at)
       VALUES (?, 'email.send', ?, 'failed', ?, ?)`
    )
    .bind(id, payload, attempts, createdAt)
    .run();
}

const row = (id: string) =>
  db
    .prepare('SELECT status, attempts FROM outbox WHERE id = ?')
    .bind(id)
    .first<{ status: string; attempts: number }>();

const alerts = () =>
  db
    .prepare("SELECT id, payload_json FROM outbox WHERE id LIKE 'outbox-alert-%'")
    .all<{ id: string; payload_json: string }>()
    .then((r) => r.results);

beforeEach(async () => {
  Object.assign(env, {
    EMAIL: {
      send: async () => {
        throw new Error('provider down');
      },
    },
  });
  ({ db, dispose } = await createTestDb());
  await db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('operational_alert_email', 'ops@example.com', ?)"
    )
    .bind(new Date().toISOString())
    .run();
});
afterEach(async () => {
  await dispose();
});

describe('MS-2 outbox email retries', () => {
  it('a row failing 7 times is retried an 8th time', async () => {
    await failedRow('ob-7', 7);
    await expect(processOutboxRow(db, 'ob-7')).rejects.toThrow('Outbox row ob-7 failed');
    expect(await row('ob-7')).toEqual({ status: 'failed', attempts: 8 });
    expect(await processOutboxRow(db, 'ob-7')).toBe(false);
  });

  it('the 8th failure enqueues exactly one ops alert', async () => {
    await failedRow('ob-6', 6);
    await expect(processOutboxRow(db, 'ob-6')).rejects.toThrow();
    expect(await alerts()).toEqual([]);
    await db.prepare("UPDATE outbox SET retry_after = NULL WHERE id = 'ob-6'").run();
    await expect(processOutboxRow(db, 'ob-6')).rejects.toThrow();
    await expect(processOutboxRow(db, 'ob-6')).resolves.toBe(false);
    const sent = await alerts();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.payload_json ?? '{}')).toMatchObject({ to: 'ops@example.com' });
  });

  it('a failed ops alert does not alert about itself', async () => {
    await failedRow('ob-7', 7);
    await expect(processOutboxRow(db, 'ob-7')).rejects.toThrow();
    const [alert] = await alerts();
    await db
      .prepare('UPDATE outbox SET attempts = 7 WHERE id = ?')
      .bind(alert?.id ?? '')
      .run();
    await expect(processOutboxRow(db, alert?.id ?? '')).rejects.toThrow();
    expect(await alerts()).toHaveLength(1);
  });

  it('the dashboard counts only emails that used every attempt', async () => {
    await failedRow('ob-retrying', 3);
    await failedRow('ob-dead', 8);
    expect(await failedEmailCount(db)).toBe(1);
  });

  it('recovery sweep finds a failed row at attempts 5', async () => {
    const queued: unknown[] = [];
    Object.assign(env, { NOTIFICATIONS: { send: async (job: unknown) => queued.push(job) } });
    await failedRow('ob-5', 5, new Date(Date.now() - 3_600_000).toISOString());
    const page = await enqueueOutboxRecoveryPage(db, await recoveryContext(db));
    expect(page.queued).toBe(1);
    expect(queued).toEqual([expect.objectContaining({ outboxId: 'ob-5' })]);
  });

  it('retention keeps a failed row below the cap', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await failedRow('ob-retrying', 5, old);
    await failedRow('ob-spent', 8, old);
    await pruneRetention(db);
    expect(await row('ob-retrying')).toEqual({ status: 'failed', attempts: 5 });
    expect(await row('ob-spent')).toBeNull();
  });
});

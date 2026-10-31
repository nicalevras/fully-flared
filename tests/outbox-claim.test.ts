import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { env as stubEnv } from './helpers/cloudflare-workers-stub';
import { MAX_EMAIL_ATTEMPTS, failedEmailCount } from '../web/src/server/outbox';
import { recoveryContext, outboxDue } from '../web/src/server/recovery-eligibility';

// P0 item 3: outbox reclaim must key on claimed_at, never created_at.
// A retried row can be hours old while a worker is actively sending it;
// reclaiming by creation time double-sends. The env stub is mutated before
// the email module is imported so sends are counted by a fake binding.
let sends = 0;
let db: D1Database;
let dispose: () => Promise<void>;
let processOutboxRow: typeof import('../web/src/server/email').processOutboxRow;

const payload = JSON.stringify({
  to: 'c@example.com',
  subject: 'Hi',
  text: 'hi',
  html: '<p>hi</p>',
});
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

beforeAll(async () => {
  stubEnv.EMAIL = {
    send: async () => {
      sends++;
    },
  };
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
  ({ processOutboxRow } = await import('../web/src/server/email'));
});

describe('outbox claimed_at reclaim', () => {
  it('an old row with a fresh claim is not reclaimed (no double send)', async () => {
    // Created 2h ago (retried for a long time), claimed 1 minute ago by a
    // worker that is still sending. A second claim must be refused.
    await db
      .prepare(
        `INSERT INTO outbox (id, type, payload_json, status, attempts, created_at, claimed_at)
       VALUES ('ob-live', 'email.send', ?, 'sending', 1, ?, ?)`
      )
      .bind(payload, iso(2 * 3600_000), iso(60_000))
      .run();
    const claimed = await processOutboxRow(db, 'ob-live');
    expect(claimed).toBe(false);
    expect(sends).toBe(0);
  }, 60_000);

  it('a stale claim is reclaimed exactly once by concurrent claimants', async () => {
    await db
      .prepare(
        `INSERT INTO outbox (id, type, payload_json, status, attempts, created_at, claimed_at)
       VALUES ('ob-stale', 'email.send', ?, 'sending', 1, ?, ?)`
      )
      .bind(payload, iso(2 * 3600_000), iso(20 * 60_000))
      .run();
    const results = await Promise.all([
      processOutboxRow(db, 'ob-stale'),
      processOutboxRow(db, 'ob-stale'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sends).toBe(1);
    const row = await db
      .prepare('SELECT status, attempts FROM outbox WHERE id = ?')
      .bind('ob-stale')
      .first<{ status: string; attempts: number }>();
    expect(row?.status).toBe('sent');
    // The reclaim counted as an attempt (1 original + 1 reclaim).
    expect(row?.attempts).toBe(2);
  }, 60_000);

  it('a crash loop stops at the attempt cap', async () => {
    await db
      .prepare(
        `INSERT INTO outbox (id, type, payload_json, status, attempts, created_at, claimed_at)
       VALUES ('ob-capped', 'email.send', ?, 'sending', ?, ?, ?)`
      )
      .bind(payload, MAX_EMAIL_ATTEMPTS, iso(3600_000), iso(20 * 60_000))
      .run();
    await db
      .prepare(
        "INSERT INTO settings(key,value,updated_at) VALUES('operational_alert_email','ops@example.invalid','2026') ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run();
    const due = outboxDue(await recoveryContext(db));
    expect(
      await db
        .prepare(`SELECT 1 FROM outbox o WHERE o.id='ob-capped' AND ${due.sql}`)
        .bind(...due.values)
        .first()
    ).not.toBeNull();
    const claimed = await processOutboxRow(db, 'ob-capped');
    expect(claimed).toBe(false);
    expect(sends).toBe(1);
    expect(
      await db.prepare("SELECT status,attempts FROM outbox WHERE id='ob-capped'").first()
    ).toEqual({ status: 'failed', attempts: MAX_EMAIL_ATTEMPTS });
    expect(await failedEmailCount(db)).toBe(1);
    await processOutboxRow(db, 'ob-capped');
    expect(
      (await db.prepare("SELECT id FROM outbox WHERE id LIKE 'outbox-alert-ob-capped-%'").all())
        .results
    ).toHaveLength(1);
  }, 60_000);
});

afterAll(async () => {
  await dispose();
});

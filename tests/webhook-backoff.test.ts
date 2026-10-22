import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';
import { processInboxEvent, reprocessStaleInbox } from '../web/src/server/checkout';
import { nextRetryIso } from '../web/src/server/retry';

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  dispose = t.dispose;
});
afterAll(async () => {
  await dispose();
});

describe('retry backoff helper', () => {
  it('doubles from 60s and caps at one hour', () => {
    const base = new Date('2026-01-01T00:00:00.000Z');
    expect(nextRetryIso(1, base)).toBe('2026-01-01T00:01:00.000Z');
    expect(nextRetryIso(2, base)).toBe('2026-01-01T00:02:00.000Z');
    expect(nextRetryIso(3, base)).toBe('2026-01-01T00:04:00.000Z');
    expect(nextRetryIso(20, base)).toBe('2026-01-01T01:00:00.000Z');
  });
});

describe('webhook inbox backoff (E24)', () => {
  it('a failed event gets a future retry_after and the sweep honors it', async () => {
    await db
      .prepare(
        `INSERT INTO webhook_inbox (id, provider, event_id, type, payload_json, status, attempts, received_at)
         VALUES ('inbox-backoff', 'stripe', 'evt_backoff', 'checkout.session.completed', 'not-json', 'failed', 1, ?)`
      )
      .bind(new Date().toISOString())
      .run();
    await processInboxEvent(db, 'evt_backoff');
    const row = await db
      .prepare('SELECT attempts, retry_after FROM webhook_inbox WHERE event_id = ?')
      .bind('evt_backoff')
      .first<{ attempts: number; retry_after: string }>();
    expect(row?.attempts).toBe(2);
    expect(new Date(row?.retry_after ?? 0).getTime()).toBeGreaterThan(Date.now() + 30_000);

    // Sweep must skip it while the backoff instant is in the future.
    await reprocessStaleInbox(db, null);
    const after = await db
      .prepare('SELECT attempts FROM webhook_inbox WHERE event_id = ?')
      .bind('evt_backoff')
      .first<{ attempts: number }>();
    expect(after?.attempts).toBe(2);

    // Once due, the sweep picks it up again (and fails again, attempts 3).
    await db
      .prepare(
        "UPDATE webhook_inbox SET retry_after = '2000-01-01T00:00:00.000Z' WHERE event_id = 'evt_backoff'"
      )
      .run();
    await reprocessStaleInbox(db, null);
    const final = await db
      .prepare('SELECT attempts FROM webhook_inbox WHERE event_id = ?')
      .bind('evt_backoff')
      .first<{ attempts: number }>();
    expect(final?.attempts).toBe(3);
  });
});

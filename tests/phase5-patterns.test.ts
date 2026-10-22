import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedProduct } from './helpers/d1';
import { formatMoney, slugify, formatDate } from '../web/src/lib/format';

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

const VISIBLE =
  "(status = 'published' AND (published_at IS NULL OR datetime(published_at) <= datetime('now'))) " +
  "OR (status = 'scheduled' AND published_at IS NOT NULL AND datetime(published_at) <= datetime('now'))";

describe('phase 5 data patterns', () => {
  it('shared format helpers behave once, everywhere', () => {
    expect(slugify('  Canyon Coffee — Dark Roast! ')).toBe('canyon-coffee-dark-roast');
    expect(formatMoney(1299, 'USD')).toBe('$12.99');
    expect(formatMoney(1299, 'EUR')).toContain('12.99');
    expect(formatDate('2026-01-02T12:00:00.000Z')).toBe('January 2, 2026');
  });

  it('orders carry abandoned_reminded_at and invalid statuses are rejected by the guard', async () => {
    await seedProduct(db, { onHand: 3 });
    const cols = await db.prepare('PRAGMA table_info(orders)').all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain('abandoned_reminded_at');
    await expect(
      db
        .prepare(
          "INSERT INTO orders (id, number, customer_email, currency, subtotal_cents, total_cents, status, payment_status, checkout_attempt_id, created_at, updated_at) VALUES ('o-bad', '9001', 'a@example.com', 'USD', 100, 100, 'cancelled', 'unpaid', 'k-bad', ?, ?)"
        )
        .bind(new Date().toISOString(), new Date().toISOString())
        .run()
    ).rejects.toThrow();
  });

  it('a scheduled post becomes visible at its time and a future one stays hidden', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await db.batch([
      db
        .prepare(
          "INSERT INTO posts (id, slug, title, status, published_at, created_at, updated_at) VALUES ('post-due', 'due', 'Due', 'scheduled', ?, ?, ?)"
        )
        .bind(past, past, past),
      db
        .prepare(
          "INSERT INTO posts (id, slug, title, status, published_at, created_at, updated_at) VALUES ('post-future', 'future', 'Future', 'scheduled', ?, ?, ?)"
        )
        .bind(future, past, past),
      db
        .prepare(
          "INSERT INTO posts (id, slug, title, status, published_at, created_at, updated_at) VALUES ('post-draft', 'drafty', 'Draft', 'draft', NULL, ?, ?)"
        )
        .bind(past, past),
    ]);
    const rows = await db
      .prepare(`SELECT slug FROM posts WHERE ${VISIBLE} ORDER BY slug`)
      .all<{ slug: string }>();
    expect(rows.results.map((r) => r.slug)).toEqual(['due']);
  });

  it('an ISO published_at earlier today is visible (no next-UTC-day delay)', async () => {
    const earlierToday = new Date(Date.now() - 5_000).toISOString();
    await db
      .prepare(
        "INSERT INTO posts (id, slug, title, status, published_at, created_at, updated_at) VALUES ('post-now', 'just-now', 'Now', 'published', ?, ?, ?)"
      )
      .bind(earlierToday, earlierToday, earlierToday)
      .run();
    const row = await db
      .prepare(`SELECT slug FROM posts WHERE slug = 'just-now' AND (${VISIBLE})`)
      .first();
    expect(row).not.toBeNull();
  });
});

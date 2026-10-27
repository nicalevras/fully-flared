import { expect, it } from 'vitest';
import { createTestDb } from './helpers/d1';

const enabled = process.env.GLOBAL_SEARCH_100K === '1';

type Shape = { name: string; sql: string; binds: unknown[] };

const prefix = 'zz-target-';
const escaped = `${prefix}%`;

const shapes: Shape[] = [
  {
    name: 'shipped_union',
    sql: `SELECT email FROM (
             SELECT lower(customer_email) AS email FROM orders
             UNION
             SELECT lower(email) AS email FROM user
           ) WHERE email LIKE ? ESCAPE '\\' ORDER BY email LIMIT 5`,
    binds: [escaped],
  },
  {
    name: 'orders_like_group',
    sql: `SELECT lower(customer_email) AS email FROM orders WHERE customer_email LIKE ? ESCAPE '\\' GROUP BY email ORDER BY email LIMIT 5`,
    binds: [escaped],
  },
  {
    name: 'user_like_group',
    sql: `SELECT lower(email) AS email FROM user WHERE email LIKE ? ESCAPE '\\' GROUP BY email ORDER BY email LIMIT 5`,
    binds: [escaped],
  },
  {
    name: 'orders_range_group',
    sql: `SELECT lower(customer_email) AS email FROM orders WHERE customer_email >= ? AND customer_email < ? GROUP BY email ORDER BY email LIMIT 5`,
    binds: [prefix, `${prefix}\ufffd`],
  },
  {
    name: 'user_range_group',
    sql: `SELECT lower(email) AS email FROM user WHERE email >= ? AND email < ? GROUP BY email ORDER BY email LIMIT 5`,
    binds: [prefix, `${prefix}\ufffd`],
  },
];

it.runIf(enabled)(
  'benchmarks customer email prefix shapes at 100000 orders',
  { timeout: 600000 },
  async () => {
    const { db, dispose } = await createTestDb({ transportRetry: true });
    try {
      for (let start = 1; start <= 100000; start += 1000) {
        const rows = Array.from({ length: Math.min(1000, 100001 - start) }, (_, offset) => {
          const n = start + offset;
          const email =
            n > 99990
              ? `zz-target-${String(n - 99991).padStart(2, '0')}@example.invalid`
              : `bulk${String(n).padStart(6, '0')}@example.invalid`;
          return { id: `o${n}`, number: `FF-${n}`, email };
        });
        await db
          .prepare(
            `INSERT INTO orders(id, number, status, payment_status, customer_email, currency, subtotal_cents, total_cents, created_at, updated_at)
             SELECT json_extract(value,'$.id'), json_extract(value,'$.number'), 'paid', 'paid', json_extract(value,'$.email'), 'USD', 1000, 1000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z' FROM json_each(?)`
          )
          .bind(JSON.stringify(rows))
          .run();
      }
      await db
        .prepare(
          `INSERT INTO user(id, name, email, email_verified, created_at, updated_at)
           VALUES ('target-user', 'Target', 'zz-target-account@example.invalid', 1, 1, 1)`
        )
        .run();

      for (const shape of shapes) {
        const plan = await db
          .prepare(`EXPLAIN QUERY PLAN ${shape.sql}`)
          .bind(...shape.binds)
          .all<{ detail: string }>();
        console.warn(
          JSON.stringify({ shape: shape.name, plan: plan.results.map((row) => row.detail) })
        );
      }

      for (let round = 0; round < 5; round++) {
        for (const shape of shapes) {
          const started = performance.now();
          const result = await db
            .prepare(shape.sql)
            .bind(...shape.binds)
            .all<{ email: string }>();
          console.warn(
            JSON.stringify({
              shape: shape.name,
              round,
              rowsRead: result.meta.rows_read,
              durationMs: Math.round(performance.now() - started),
              emails: result.results.map((row) => row.email),
            })
          );
          if (
            shape.name === 'shipped_union' ||
            shape.name === 'orders_like_group' ||
            shape.name === 'orders_range_group'
          ) {
            expect(result.results.map((row: { email: string }) => row.email)).toEqual([
              'zz-target-00@example.invalid',
              'zz-target-01@example.invalid',
              'zz-target-02@example.invalid',
              'zz-target-03@example.invalid',
              'zz-target-04@example.invalid',
            ]);
          }
        }
      }
    } finally {
      await dispose();
    }
  }
);

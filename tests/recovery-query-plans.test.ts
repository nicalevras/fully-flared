import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, applyMigrationFile } from './helpers/d1';
import {
  recoveryContext,
  outboxDue,
  refundDue,
  refundAlertDue,
  webhookDue,
} from '../web/src/server/recovery-eligibility';

it('records before/after recovery query plans on populated data and preserves eligible rows', async () => {
  const { db, dispose } = await createTestDb({ through: '0016_checkout_and_media_recovery.sql' });
  try {
    await db
      .prepare(
        `INSERT INTO orders(id,number,status,payment_status,customer_email,currency,
      subtotal_cents,total_cents,created_at,updated_at) VALUES('plan-order','PLAN','paid','paid',
      'fixture@example.invalid','USD',10000,10000,'2026-01-01','2026-01-01')`
      )
      .run();
    for (let start = 0; start < 1000; start += 20) {
      const statements = [];
      for (let i = start; i < start + 20; i++) {
        const status = i % 10 === 0;
        statements.push(
          db
            .prepare(
              `INSERT INTO outbox(id,type,payload_json,status,created_at,claimed_at,retry_after)
          VALUES(?,'email.send','{}',?,'2026-01-01','2026-01-01',?)`
            )
            .bind(
              `plan-mail-${i}`,
              status ? (i % 20 === 0 ? 'sending' : 'pending') : 'sent',
              i % 3 === 0 ? '2999-01-01' : null
            )
        );
        statements.push(
          db
            .prepare(
              `INSERT INTO refunds(id,request_id,order_id,amount_cents,purpose,status,created_at,retry_after)
          VALUES(?,?,'plan-order',1,'staff',?,'2026-01-01',?)`
            )
            .bind(
              `plan-refund-${i}`,
              `plan-refund-${i}`,
              status ? 'uncertain' : 'succeeded',
              i % 3 === 0 ? '2999-01-01' : null
            )
        );
        statements.push(
          db
            .prepare(
              `INSERT INTO webhook_inbox(id,event_id,type,payload_json,status,received_at)
          VALUES(?,?,'fixture','{}',?,'2026-01-01')`
            )
            .bind(`plan-event-${i}`, `plan-event-${i}`, status ? 'pending' : 'processed')
        );
      }
      await db.batch(statements);
    }
    const context = await recoveryContext(db);
    context.recipients = ['ops@example.invalid'];
    const outbox = outboxDue(context),
      refund = refundDue(context),
      alert = refundAlertDue(context),
      webhook = webhookDue(context);
    const queries = [
      {
        name: 'outbox-page',
        sql: `SELECT o.id FROM outbox o WHERE ${outbox.sql} ORDER BY o.created_at,o.id LIMIT 25`,
        values: outbox.values,
      },
      {
        name: 'refund-page',
        sql: `SELECT r.id FROM refunds r WHERE r.id>? AND ${refund.sql} ORDER BY r.id LIMIT 25`,
        values: ['', ...refund.values],
      },
      {
        name: 'refund-alert',
        sql: `SELECT r.id FROM refunds r WHERE ${alert.sql} ORDER BY r.created_at,r.id LIMIT 25`,
        values: alert.values,
      },
      {
        name: 'webhook-page',
        sql: `SELECT w.event_id FROM webhook_inbox w WHERE ${webhook.sql} ORDER BY w.received_at,w.event_id LIMIT 25`,
        values: webhook.values,
      },
    ];
    async function capture() {
      return Promise.all(
        queries.map(async (q) => {
          const plan = await db
            .prepare('EXPLAIN QUERY PLAN ' + q.sql)
            .bind(...q.values)
            .all();
          const rows = await db
            .prepare(q.sql)
            .bind(...q.values)
            .all();
          return {
            name: q.name,
            sql: q.sql,
            plan: plan.results,
            rows: rows.results,
            rowsRead: rows.meta.rows_read,
          };
        })
      );
    }
    const before = await capture();
    await applyMigrationFile(db, '0017_due_recovery_indexes.sql');
    const after = await capture();
    expect(after.map((q) => q.rows)).toEqual(before.map((q) => q.rows));
    if (process.env.STORE_HARDENING_EVIDENCE) {
      mkdirSync(process.env.STORE_HARDENING_EVIDENCE, { recursive: true });
      writeFileSync(
        join(process.env.STORE_HARDENING_EVIDENCE, 'recovery-query-plans.json'),
        JSON.stringify({ before, after }, null, 2)
      );
    }
  } finally {
    await dispose();
  }
});

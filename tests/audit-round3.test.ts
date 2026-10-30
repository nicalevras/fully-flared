import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deliverStripeEvent } from './helpers/webhook';
import { readFileSync } from 'node:fs';
import { createTestDb, seedProduct } from './helpers/d1';
import { addCartLine, ensureCart } from '../web/src/server/cart';
import { attachStripeSession } from './helpers/attach-session';
import { enqueueOutboxRecoveryPage, processOutboxRow } from '../web/src/server/email';
import { recoveryContext } from '../web/src/server/recovery-eligibility';
import { emailStatement, commitWithEmails } from '../web/src/server/outbox';
import { requestRefund, settleRefund } from '../web/src/server/refunds';
import { runAdminAction } from '../web/src/server/admin-actions';
import { workerEnv } from '../web/src/server/env';
import { fakeAdmissionNamespace } from './helpers/admission';
import { reconcileStripe } from '../web/src/server/reconcile';
import Stripe from '../web/node_modules/stripe/esm/stripe.esm.node.js';
import { StripeProvider, type PaymentProvider } from '../web/src/server/payments';
import * as payments from '../web/src/server/payments';
import { heldOrder } from './helpers/pending-intent';
import { at, present } from './helpers/fixtures';
import { fakeQueue } from './helpers/queue';
import { z } from './helpers/json';

const outboxJob = z.object({ outboxId: z.string() });
vi.mock('@tanstack/react-start/server-entry', () => ({ default: { fetch: vi.fn() } }));

let db: D1Database, env: Env, dispose: () => Promise<void>;
beforeEach(async () => {
  ({ db, env, dispose } = await createTestDb());
  await seedProduct(db, { onHand: 20 });
  await db
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,role,created_at,updated_at) VALUES('owner','Owner','owner@example.invalid',1,'owner',0,0)"
    )
    .run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(workerEnv, 'JOBS');
  Reflect.deleteProperty(workerEnv, 'EMAIL');
  await dispose();
});
function tracedDatabase(after: (sql: string[]) => Promise<void>) {
  const queries = new WeakMap<object, string>();
  const originals = new WeakMap<object, D1PreparedStatement>();
  function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === 'bind')
          return (...values: Parameters<D1PreparedStatement['bind']>) =>
            wrap(target.bind(...values), sql);
        if (['all', 'first', 'run', 'raw'].includes(String(key)))
          return async (...args: unknown[]) => {
            const member = Reflect.get(target, key);
            const result = await member.apply(target, args);
            await after([sql]);
            return result;
          };
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    queries.set(proxy, sql);
    originals.set(proxy, statement);
    return proxy;
  }
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements.map((s) => originals.get(s) ?? s));
          await after(statements.map((s) => queries.get(s) ?? ''));
          return result;
        };
      const member = Reflect.get(target, key);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

it('atomically increments concurrent cart additions without stock checks and retains configured limits', async () => {
  const cart = await ensureCart(db, null);
  await Promise.all(Array.from({ length: 20 }, () => addCartLine(db, cart.creds, 'TEE-1', 2)));
  expect(
    (await db.prepare('SELECT qty FROM cart_items WHERE cart_id=?').bind(cart.creds.id).first())
      ?.qty
  ).toBe(40);
  await db.prepare("UPDATE settings SET value='41' WHERE key='cart_max_qty'").run();
  const result = await Promise.allSettled([
    addCartLine(db, cart.creds, 'TEE-1', 1),
    addCartLine(db, cart.creds, 'TEE-1', 1),
  ]);
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect((await db.prepare('SELECT reserved FROM stock').first())?.reserved).toBe(0);
});

it('enqueues a committed receipt immediately, and a queue failure leaves cron recovery intact', async () => {
  const emailSend = vi.fn();
  workerEnv.EMAIL = { send: emailSend };
  const sent: string[] = [];
  workerEnv.NOTIFICATIONS = fakeQueue(async (body) => {
    const job = outboxJob.parse(body);
    expect(
      (await db.prepare('SELECT status FROM outbox WHERE id=?').bind(job.outboxId).first())?.status
    ).toBe('pending');
    sent.push(job.outboxId);
    throw new Error('queue unavailable');
  });
  const o = await heldOrder(db, {
    email: 'buyer@example.invalid',
    shippingCountry: 'US',
    shippingRateId: 'test-rate',
    lines: [{ sku: 'TEE-1', qty: 1 }],
  });
  await attachStripeSession(db, o.orderId, 'cs_receipt');
  const provider: PaymentProvider = {
    createCheckout: async () => ({ sessionId: 'unused', url: 'unused' }),
    refund: async () => ({ id: 'unused', status: 'pending' }),
    verifyWebhook: async (payload) => {
      const e = JSON.parse(payload);
      return { ...e, data: e.data.object };
    },
  };
  await deliverStripeEvent(
    db,
    provider,
    JSON.stringify({
      id: 'evt_receipt',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_receipt',
          payment_status: 'paid',
          payment_intent: 'pi_receipt',
          amount_total: 2000,
          currency: 'usd',
          metadata: { order_id: o.orderId },
          collected_information: {
            shipping_details: { name: 'Fixture', address: { country: 'US', line1: 'Fixture' } },
          },
        },
      },
    }),
    'test'
  );
  expect(sent).toContain(`receipt-${o.orderId}`);
  workerEnv.NOTIFICATIONS = fakeQueue();
  expect((await enqueueOutboxRecoveryPage(db, await recoveryContext(db))).queued).toBe(1);
  expect(emailSend).not.toHaveBeenCalled();
  expect(await processOutboxRow(db, `receipt-${o.orderId}`)).toBe(true);
  expect(emailSend).toHaveBeenCalledTimes(1);
});

it('enqueues shipment and refund notifications after commit, never after a rolled-back insert', async () => {
  const ids: string[] = [];
  workerEnv.NOTIFICATIONS = fakeQueue((body) => {
    ids.push(outboxJob.parse(body).outboxId);
  });
  await db
    .prepare(
      "INSERT INTO orders(id,number,status,payment_status,customer_email,total_cents,subtotal_cents,stripe_payment_intent_id,created_at,updated_at) VALUES('notice','NOTICE','paid','paid','fixture@example.invalid',2000,2000,'pi_notice','2026','2026')"
    )
    .run();
  expect(
    (
      await runAdminAction(db, env, { id: 'owner', role: 'owner' }, 'order.ship', {
        orderId: 'notice',
        trackingNumber: 'FIXTURE',
      })
    ).ok
  ).toBe(true);
  expect(ids).toContain('shipment-notice');
  const provider: PaymentProvider = {
    createCheckout: async () => ({ sessionId: 'unused', url: 'unused' }),
    refund: async () => ({ id: 're_notice', status: 'requires_action' }),
    verifyWebhook: async () => ({ id: 'unused', type: 'unused', data: {} }),
  };
  await requestRefund(db, provider, {
    orderId: 'notice',
    requestId: 'notice-refund',
    purpose: 'staff',
  });
  expect(ids).toContain('refund-alert-notice-refund-requires_action-owner@example.invalid');
  await settleRefund(db, 'notice-refund', 'succeeded', 're_notice');
  expect(ids).toContain('refund-notice-refund');
  const before = ids.length;
  await expect(
    commitWithEmails(
      db,
      [
        emailStatement(db, 'rolled-back', {
          to: 'fixture@example.invalid',
          subject: 'Fixture',
          text: 'Fixture',
          html: 'Fixture',
        }),
        db.prepare('INSERT INTO batch_guard SELECT 1'),
      ],
      ['rolled-back']
    )
  ).rejects.toThrow();
  expect(ids).toHaveLength(before);
  expect(await db.prepare("SELECT id FROM outbox WHERE id='rolled-back'").first()).toBeNull();
});

it('resumes bounded reconciliation pages and never advances a failed provider page', async () => {
  const ids = Array.from({ length: 130 }, (_, i) => String(i).padStart(3, '0'));
  for (const id of ids)
    await db
      .prepare(
        "INSERT INTO orders(id,number,status,payment_status,customer_email,total_cents,subtotal_cents,stripe_checkout_session_id,created_at,updated_at) VALUES(?,?,'shipped','paid','fixture@example.invalid',2000,2000,?,'2026','2026')"
      )
      .bind('page-' + id, 'PAGE-' + id, 'cs_' + id)
      .run();
  const seen = new Set<string>();
  const pages: (string | undefined)[] = [];
  const session = (id: string) => ({
    id: 'cs_' + id,
    payment_status: 'paid',
    amount_total: 2000,
    currency: 'usd',
    payment_intent: 'pi_' + id,
  });
  const provider: PaymentProvider = {
    createCheckout: async () => ({ sessionId: 'unused', url: 'unused' }),
    refund: async () => ({ id: 'unused', status: 'pending' }),
    verifyWebhook: async () => ({ id: 'unused', type: 'unused', data: {} }),
    listCheckoutSessionsPage: async ({ limit, startingAfter }) => {
      pages.push(startingAfter);
      const from = startingAfter ? ids.indexOf(startingAfter.slice(3)) + 1 : 0;
      return {
        data: ids.slice(from, from + limit).map(session),
        hasMore: from + limit < ids.length,
      };
    },
    retrieveCheckoutSession: async (id) => {
      seen.add(id);
      return session(id.slice(3));
    },
  };
  const first = await reconcileStripe(db, provider);
  expect(first.checkedStripeSessions).toBe(100);
  expect(first.checkedOrders).toBe(25);
  for (let i = 0; i < 5; i++) await reconcileStripe(db, provider);
  expect(seen.size).toBe(130);
  expect(pages[1]).toBe('cs_099');
  const before = await db
    .prepare("SELECT cursor FROM reconciliation_cursors WHERE name='stripe_sessions'")
    .first();
  provider.listCheckoutSessionsPage = async () => {
    throw new Error('provider unavailable');
  };
  await expect(reconcileStripe(db, provider)).rejects.toThrow('provider unavailable');
  expect(
    await db
      .prepare("SELECT cursor FROM reconciliation_cursors WHERE name='stripe_sessions'")
      .first()
  ).toEqual(before);
});

it('progresses beyond the first refund, stock and refund-invariant pages', async () => {
  for (let i = 0; i < 61; i++) {
    const id = String(i).padStart(3, '0');
    await db.batch([
      db
        .prepare(
          "INSERT INTO orders(id,number,status,payment_status,customer_email,total_cents,subtotal_cents,created_at,updated_at) VALUES(?,?,'paid','paid','fixture@example.invalid',2000,2000,'2026','2026')"
        )
        .bind('paged-' + id, 'PAGED-' + id),
      db
        .prepare(
          "INSERT INTO refunds(id,request_id,order_id,stripe_refund_id,amount_cents,status,created_at) VALUES(?,?,?,?,100,?,'2026')"
        )
        .bind(
          'refund-' + id,
          'refund-' + id,
          'paged-' + id,
          're_' + id,
          i === 60 ? 'succeeded' : 'pending'
        ),
      db
        .prepare(
          "INSERT INTO variants(id,product_id,sku,title,price_cents,created_at) VALUES(?,'p1',?,'Fixture',2000,'2026')"
        )
        .bind('variant-' + id, 'SKU-' + id),
      db
        .prepare("INSERT INTO stock(sku,on_hand,reserved,updated_at) VALUES(?,1,0,'2026')")
        .bind('SKU-' + id),
      db
        .prepare(
          "INSERT INTO stock_ledger(id,sku,delta_on_hand,reason,created_at) VALUES(?,?,?,'restock','2026')"
        )
        .bind('ledger-' + id, 'SKU-' + id, i === 60 ? 0 : 1),
    ]);
  }
  const seen = new Set<string>();
  const provider: PaymentProvider = {
    createCheckout: async () => ({ sessionId: 'unused', url: 'unused' }),
    refund: async () => ({ id: 'unused', status: 'pending' }),
    verifyWebhook: async () => ({ id: 'unused', type: 'unused', data: {} }),
    retrieveRefund: async (id) => {
      seen.add(id);
      return { id, status: id === 're_060' ? 'succeeded' : 'pending' };
    },
  };
  const reports = [];
  for (let i = 0; i < 3; i++) reports.push(await reconcileStripe(db, provider));
  expect(reports.map((r) => r.checkedRefunds)).toEqual([25, 25, 11]);
  expect(seen.size).toBe(61);
  expect(reports.flatMap((r) => r.mismatches)).toContain('stock_ledger_drift:SKU-060');
  expect(reports.flatMap((r) => r.mismatches)).toContain('refund_total_mismatch:paged-060');
});

it('instruments the combined nightly cron without a maintenance queue', async () => {
  const sessions = Array.from({ length: 100 }, (_, i) => ({
    id: 'cs_cron_' + i,
    payment_status: 'paid',
    amount_total: 2000,
    currency: 'usd',
    payment_intent: 'pi_cron_' + i,
  }));
  for (let i = 0; i < 100; i++)
    await db
      .prepare(
        "INSERT INTO orders(id,number,status,payment_status,customer_email,total_cents,subtotal_cents,stripe_checkout_session_id,stripe_payment_intent_id,created_at,updated_at) VALUES(?,?,'paid','paid','fixture@example.invalid',2000,2000,?,?,'2026','2026')"
      )
      .bind('cron-' + i, 'CRON-' + i, at(sessions, i).id, 'pi_cron_' + i)
      .run();
  for (let i = 0; i < 25; i++)
    await db.batch([
      db
        .prepare(
          "INSERT INTO refunds(id,request_id,order_id,stripe_refund_id,amount_cents,status,created_at) VALUES(?,?,?,?,100,'pending','2026')"
        )
        .bind('cron-refund-' + i, 'cron-refund-' + i, 'cron-' + i, 're_cron_' + i),
      db
        .prepare(
          "INSERT INTO outbox(id,type,payload_json,created_at) VALUES(?,'email.send',?,'2026')"
        )
        .bind(
          'cron-outbox-' + i,
          JSON.stringify({
            to: 'fixture@example.invalid',
            subject: 'Fixture',
            text: 'Fixture',
            html: '<p>Fixture</p>',
          })
        ),
    ]);
  const provider: PaymentProvider = {
    createCheckout: async () => ({ sessionId: 'unused', url: 'unused' }),
    refund: async () => ({ id: 'unused', status: 'pending' }),
    verifyWebhook: async () => ({ id: 'unused', type: 'unused', data: {} }),
    listCheckoutSessionsPage: async () => ({ data: sessions, hasMore: false }),
    retrieveCheckoutSession: async (id) => sessions.find((s) => s.id === id) ?? null,
    retrieveRefund: async (id) => ({ id, status: 'pending' }),
  };
  vi.spyOn(payments, 'getStripeProvider').mockReturnValue(provider as never);
  workerEnv.EMAIL = { send: vi.fn() };
  workerEnv.JOBS = fakeQueue();
  workerEnv.NOTIFICATIONS = fakeQueue();
  workerEnv.CATALOG_JOBS = fakeQueue();
  const { default: worker } = await import('../web/src/server');
  let statements = 0;
  let batchCalls = 0;
  const traced = tracedDatabase(async (sql) => {
    statements += sql.length;
    if (sql.length > 1) batchCalls++;
  });
  const pending: Promise<unknown>[] = [];
  await worker.scheduled(
    { cron: '0 3 * * *', scheduledTime: Date.now(), noRetry: () => {} },
    {
      ...workerEnv,
      DB: traced,
      CHECKOUT_ADMISSION: fakeAdmissionNamespace().namespace,
    } as never,
    {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      exports: {
        PublicStorefront: { purgeInvalidations: async () => {} },
      },
    } as never
  );
  await Promise.all(pending);
  expect(statements).toBeLessThan(1000);
  console.warn(
    `Combined cron fixture: D1 statements=${statements}, multi-statement batches=${batchCalls}; 100 sessions, 25 refunds and 25 emails. Local instrumentation, not a deployed limit test.`
  );
  Reflect.deleteProperty(workerEnv, 'NOTIFICATIONS');
  Reflect.deleteProperty(workerEnv, 'CATALOG_JOBS');
});

it('distinguishes confirmed missing Stripe objects from outages', async () => {
  const provider = new StripeProvider('sk_test_fixture', 'whsec_fixture');
  const stripe = (
    provider as unknown as {
      stripe: { checkout: { sessions: { retrieve: (id: string) => Promise<unknown> } } };
    }
  ).stripe;
  const retrieve = vi.spyOn(stripe.checkout.sessions, 'retrieve');
  retrieve.mockRejectedValueOnce(
    new Stripe.errors.StripeInvalidRequestError({
      message: 'missing',
      statusCode: 404,
      code: 'resource_missing',
    })
  );
  expect(await provider.retrieveCheckoutSession('cs_missing')).toBeNull();
  retrieve.mockRejectedValueOnce(new Error('provider outage'));
  await expect(provider.retrieveCheckoutSession('cs_outage')).rejects.toThrow('provider outage');
});

it('builds preview artifacts inside the preview job before deployment', () => {
  const workflow = present(
    readFileSync('.github/workflows/ci.yml', 'utf8').split('  preview-deploy:')[1],
    'the preview-deploy job'
  );
  expect(workflow).toMatch(/CLOUDFLARE_ENV=preview npm run build/);
  expect(workflow.indexOf('CLOUDFLARE_ENV=preview npm run build')).toBeLessThan(
    workflow.indexOf('npx wrangler deploy')
  );
});

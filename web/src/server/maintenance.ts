import * as z from 'zod';
import type { WorkerEnv } from './env';
import { getStripeProvider, providerWithBudget } from './payments';
import { getSettings } from './settings';
import { releaseExpiredReservations } from './inventory';
import { reprocessStaleInbox } from './checkout';
import { reconcileCheckoutIntents } from './checkout-intents';
import { recoverAuthorizedCheckouts } from './authorized-checkout';
import { reconcileRefundOperations } from './refunds';
import {
  enqueueOutboxRecoveryPage,
  queueAbandonedReminder,
  commitWithEmails,
  emailStatement,
  operationalRecipients,
} from './email';
import { reconcileStripe } from './reconcile';
import { pruneRetention } from './operations';
import { reconcileCustomerOperations, privacyRecoveryReport } from './stripe-customer-privacy';
import { runCatalogUnit } from './catalog-publisher';
import { acquireCheckoutPermit } from './checkout-admission';
import { CatalogBudget } from './catalog-exec';
import {
  RECOVERY_FAMILIES,
  recoveryContext,
  recoveryFamilyDue,
  type RecoveryFamily,
} from './recovery-eligibility';

type Task =
  | RecoveryFamily
  | 'financial'
  | 'privacy'
  | 'reconciliation'
  | 'retention'
  | 'reminders'
  | 'replica'
  | 'gc'
  | 'media-publication';
const progressSchema = z
  .object({
    stage: z.number().optional(),
    cursor: z.string().optional(),
    checked: z.number().optional(),
    outboxCursor: z.object({ createdAt: z.string(), id: z.string() }).optional(),
  })
  .loose();
type MaintenanceRun = {
  id: string;
  task: Task;
  next_at: string;
  claim_expires_at: string | null;
  started_at: string;
};
const isRecoveryFamily = (task: Task): task is RecoveryFamily =>
  RECOVERY_FAMILIES.some((family) => family === task);
const runnable = (run: MaintenanceRun, clock: string) =>
  run.next_at <= clock && (!run.claim_expires_at || run.claim_expires_at <= clock);
const at = () => new Date().toISOString();
export function maintenanceQueueBinding(task: string) {
  return task === 'replica' || task === 'gc'
    ? 'CATALOG_JOBS'
    : task === 'outbox-recovery'
      ? 'NOTIFICATIONS'
      : 'JOBS';
}
async function dispatch(env: WorkerEnv, task: string, runId: string, delaySeconds = 0) {
  try {
    const queue = env[maintenanceQueueBinding(task)];
    await queue.send(
      {
        type: 'maintenance.run',
        runId,
      },
      delaySeconds ? { delaySeconds } : undefined
    );
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'maintenance_enqueue_failed',
        task,
        error: error instanceof Error ? error.name : 'unknown',
      })
    );
    return false;
  }
}

export async function startMaintenance(
  env: WorkerEnv,
  task: Task,
  bucket: string,
  cutoff = at()
): Promise<boolean> {
  if (task === 'financial') {
    // Compatibility only: old staged runs discover work, never fan out blindly.
    return (await wakeDueMaintenance(env, bucket, cutoff)).failed === 0;
  }
  const clock = at();
  const run = await ensureMaintenanceRun(env, task, bucket, cutoff, clock);
  return !run || !runnable(run, clock) || (await dispatch(env, task, run.id));
}

async function ensureMaintenanceRun(
  env: WorkerEnv,
  task: Task,
  bucket: string,
  cutoff: string,
  clock: string
): Promise<MaintenanceRun | null> {
  const id = `${task}:${bucket}`;
  // One unfinished sweep per responsibility; do not reset its coverage window.
  const active = await env.DB.prepare(
    "SELECT id,task,next_at,claim_expires_at,started_at FROM maintenance_runs WHERE task=? AND state IN ('pending','running') ORDER BY started_at LIMIT 1"
  )
    .bind(task)
    .first<MaintenanceRun>();
  if (active) return active;
  await env.DB.prepare(
    'INSERT OR IGNORE INTO maintenance_runs(id,task,cutoff,next_at,started_at,updated_at) VALUES(?,?,?,?,?,?)'
  )
    .bind(id, task, cutoff, clock, clock, clock)
    .run();
  const due = await env.DB.prepare(
    "SELECT id,task,next_at,claim_expires_at,started_at FROM maintenance_runs WHERE task=? AND state IN ('pending','running') ORDER BY started_at LIMIT 1"
  )
    .bind(task)
    .first<MaintenanceRun>();
  return due;
}

/** One bounded page or responsibility per financial Queue delivery. */
export async function runMaintenance(env: WorkerEnv, runId: string) {
  const deadline = Date.now() + 30_000;
  const db = env.DB,
    token = crypto.randomUUID(),
    now = at();
  const claim = await db
    .prepare(
      "UPDATE maintenance_runs SET state='running',claim_token=?,claim_expires_at=?,updated_at=? WHERE id=? AND state IN ('pending','running') AND next_at<=? AND (claim_expires_at IS NULL OR claim_expires_at<=?)"
    )
    .bind(token, new Date(Date.now() + 120_000).toISOString(), now, runId, now, now)
    .run();
  if (!claim.meta.changes) return;
  const run = await db
    .prepare('SELECT task,cutoff,progress_json FROM maintenance_runs WHERE id=? AND claim_token=?')
    .bind(runId, token)
    .first<{ task: Task; cutoff: string; progress_json: string }>();
  if (!run) throw new Error(`Maintenance run ${runId} lost its claim`);
  const progress = progressSchema.parse(JSON.parse(run.progress_json));
  let done = false;
  let retryAt = at();
  const assertClaim = async () => {
    if (
      !(await db
        .prepare(
          "SELECT 1 FROM maintenance_runs WHERE id=? AND claim_token=? AND state='running' AND claim_expires_at>?"
        )
        .bind(runId, token, at())
        .first())
    )
      throw Error('Maintenance claim lost');
  };
  try {
    const rawProvider = getStripeProvider(env);
    const provider = rawProvider ? providerWithBudget(rawProvider, deadline, assertClaim) : null;
    if (run.task === 'financial') {
      // Resume old staged runs by dispatching idempotent independent families.
      if (!(await startMaintenance(env, 'financial', runId, run.cutoff)))
        throw Error('Legacy financial recovery dispatch incomplete');
      done = true;
    } else if (run.task === 'outbox-recovery') {
      const context = await recoveryContext(db, run.cutoff, now);
      const page = await enqueueOutboxRecoveryPage(db, context, progress.outboxCursor);
      if (page.cursor) progress.outboxCursor = page.cursor;
      progress.checked = (progress.checked ?? 0) + page.queued;
      done = page.done;
      if (page.retry) retryAt = new Date(Date.now() + 60_000).toISOString();
    } else if (isRecoveryFamily(run.task)) {
      const context = await recoveryContext(db, run.cutoff, now);
      let checked = 0,
        limit = 25;
      if (run.task === 'reservation-expiry')
        checked = await releaseExpiredReservations(db, limit, context);
      else {
        if (!provider) throw Error('Payment provider unavailable');
        limit = 1;
        if (run.task === 'webhook-recovery') {
          const permit = await acquireCheckoutPermit(env.CHECKOUT_ADMISSION, 'settle');
          if (permit.kind !== 'acquired') checked = -1;
          else
            try {
              checked = await reprocessStaleInbox(db, provider, limit, run.cutoff, context);
            } finally {
              await permit.release();
            }
        } else if (run.task === 'checkout-preparation')
          checked = await reconcileCheckoutIntents(
            db,
            provider,
            limit,
            env.CHECKOUT_ADMISSION,
            run.cutoff,
            context
          );
        else if (run.task === 'authorization-recovery')
          checked = await recoverAuthorizedCheckouts(
            db,
            provider,
            env.CHECKOUT_ADMISSION,
            limit,
            run.cutoff,
            context
          );
        else {
          const permit = await acquireCheckoutPermit(env.CHECKOUT_ADMISSION, 'settle');
          if (permit.kind !== 'acquired') checked = -1;
          else
            try {
              checked = await reconcileRefundOperations(
                db,
                provider,
                limit,
                { runId, token },
                run.cutoff,
                context
              );
            } finally {
              await permit.release();
            }
        }
      }
      progress.checked = (progress.checked ?? 0) + Math.max(0, checked);
      done = checked >= 0 && !(await recoveryFamilyDue(db, run.task, context));
      if (!done && checked <= 0) retryAt = new Date(Date.now() + 60_000).toISOString();
    } else if (run.task === 'privacy') {
      const result = await db
        .prepare(
          'UPDATE orders SET customer_ip=NULL WHERE id IN(SELECT id FROM orders WHERE customer_ip IS NOT NULL AND created_at<? ORDER BY created_at,id LIMIT 1000)'
        )
        .bind(new Date(Date.parse(run.cutoff) - 60 * 60_000).toISOString())
        .run();
      const customers = provider
        ? await reconcileCustomerOperations(db, provider, run.cutoff)
        : { checked: 0, more: false };
      if (!progress.checked) {
        const report = await privacyRecoveryReport(db);
        if (
          report.historicalOrdersWithoutCustomerAssociation ||
          report.unresolvedCustomerOperations ||
          report.ambiguousScrubbedEmails
        )
          console.warn(JSON.stringify({ event: 'privacy_recovery_gaps', ...report }));
      }
      progress.checked = (progress.checked ?? 0) + (result.meta.changes ?? 0) + customers.checked;
      done = (result.meta.changes ?? 0) < 1000 && !customers.more;
    } else if (run.task === 'retention') {
      const results = await pruneRetention(db, Date.parse(run.cutoff));
      done = Object.values(results).every((n) => n < 1000);
      progress.checked =
        (progress.checked ?? 0) + Object.values(results).reduce((a, b) => a + b, 0);
    } else if (run.task === 'reconciliation') {
      if (!provider) throw Error('Provider unavailable for reconciliation');
      const permit = await acquireCheckoutPermit(env.CHECKOUT_ADMISSION, 'settle');
      if (permit.kind !== 'acquired') throw Error('Reconciliation admission unavailable');
      try {
        const stages = ['sessions', 'orders', 'refunds', 'stock', 'totals'] as const;
        const stage = stages[progress.stage ?? 0];
        if (!stage) throw new Error(`Reconciliation stage ${progress.stage} does not exist`);
        const report = await reconcileStripe(db, provider, {
          stage,
          cutoff: run.cutoff,
          cursorPrefix: `${runId}:`,
          claim: { runId, token },
          canContinue: async () => {
            await assertClaim();
            return deadline - Date.now() >= 5000;
          },
        });
        progress.checked =
          (progress.checked ?? 0) +
          report.checkedOrders +
          report.checkedRefunds +
          report.checkedStripeSessions;
        if (!report.more) progress.stage = (progress.stage ?? 0) + 1;
        done = (progress.stage ?? 0) >= stages.length;
        if (report.mismatches.length) {
          console.error(
            JSON.stringify({
              event: 'reconciliation_mismatch',
              runId,
              count: report.mismatches.length,
              mismatches: report.mismatches.slice(0, 20),
            })
          );
          const recipients = await operationalRecipients(db);
          await commitWithEmails(
            db,
            recipients.map((to) =>
              emailStatement(db, `reconcile-${runId}-${to}`, {
                to,
                subject: 'Reconciliation needs review',
                text: 'Inspect structured reconciliation logs before changing financial records.',
                html: '<p>Inspect reconciliation logs before changing financial records.</p>',
              })
            ),
            recipients.map((to) => `reconcile-${runId}-${to}`)
          );
        }
      } finally {
        await permit.release();
      }
    } else if (run.task === 'reminders') {
      if (!(await getSettings(db)).abandonedRemindersEnabled) done = true;
      else {
        const rows = await db
          .prepare(
            "SELECT id,number,customer_email FROM orders WHERE id>? AND created_at<=? AND status='canceled' AND payment_status='unpaid' AND abandoned_reminded_at IS NULL AND reminder_consent=1 AND reminder_suppressed_at IS NULL ORDER BY id LIMIT 50"
          )
          .bind(progress.cursor ?? '', run.cutoff)
          .all<{ id: string; number: string; customer_email: string }>();
        for (const row of rows.results) await queueAbandonedReminder(db, row);
        progress.cursor = rows.results.at(-1)?.id ?? progress.cursor ?? '';
        done = rows.results.length < 50;
      }
    } else if (run.task === 'media-publication') {
      const { publishExistingMediaPage } = await import('./media-delivery');
      const result = await publishExistingMediaPage(env, progress.cursor ?? '', run.cutoff);
      progress.cursor = result.cursor;
      progress.checked = (progress.checked ?? 0) + result.checked;
      done = result.done;
    } else {
      const result = await runCatalogUnit(db, env.CATALOG_KV, {
        budget: new CatalogBudget(),
        maintenance: run.task === 'gc' ? 'gc' : 'replica',
      });
      if (result.done) {
        if (run.task === 'gc')
          done = Boolean(
            await db
              .prepare(
                "SELECT 1 FROM catalog_gc_state WHERE id=1 AND phase='idle' AND next_run_at>?"
              )
              .bind(run.cutoff)
              .first()
          );
        else
          done = Boolean(
            await db
              .prepare(
                "SELECT 1 FROM catalog_builds WHERE id='catalog-replica-verification' AND state='done' AND datetime(updated_at)>=datetime(?)"
              )
              .bind(run.cutoff)
              .first()
          );
      }
    }
    await assertClaim();
    const saved = await db
      .prepare(
        'UPDATE maintenance_runs SET state=?,progress_json=?,claim_token=NULL,claim_expires_at=NULL,next_at=?,updated_at=?,completed_at=? WHERE id=? AND claim_token=? AND claim_expires_at>?'
      )
      .bind(
        done ? 'done' : 'pending',
        JSON.stringify(progress),
        retryAt,
        at(),
        done ? at() : null,
        runId,
        token,
        at()
      )
      .run();
    if (!saved.meta.changes) throw Error('Maintenance claim lost');
    if (
      !done &&
      !(await dispatch(
        env,
        run.task,
        runId,
        Math.max(0, Math.ceil((Date.parse(retryAt) - Date.now()) / 1000))
      ))
    )
      throw Error('Maintenance continuation enqueue failed');
    console.warn(
      JSON.stringify({
        event: 'maintenance_progress',
        task: run.task,
        runId,
        done,
        progress,
        coverageCutoff: run.cutoff,
      })
    );
  } catch (error) {
    await db
      .prepare(
        "UPDATE maintenance_runs SET state='pending',claim_token=NULL,claim_expires_at=NULL,next_at=?,updated_at=? WHERE id=? AND claim_token=?"
      )
      .bind(new Date(Date.now() + 60_000).toISOString(), at(), runId, token)
      .run();
    throw error;
  }
}

export async function wakeDueMaintenance(
  env: WorkerEnv,
  bucket = String(Math.floor(Date.now() / (15 * 60_000))),
  cutoff?: string
) {
  const clock = at();
  const context = await recoveryContext(env.DB, cutoff, clock);
  const rows = await env.DB.prepare(
    "SELECT id,task,started_at,next_at,claim_expires_at FROM maintenance_runs WHERE state IN ('pending','running') ORDER BY next_at,id LIMIT 50"
  ).all<MaintenanceRun>();
  const runs = new Map(rows.results.map((run) => [run.id, run]));
  const activeTasks = new Set(rows.results.map((run) => run.task));
  const checks = await Promise.allSettled(
    RECOVERY_FAMILIES.map(async (family) => ({
      family,
      due: await recoveryFamilyDue(env.DB, family, context),
    }))
  );
  let failed = 0,
    eligible = 0;
  for (const [index, check] of checks.entries()) {
    if (check.status === 'rejected') {
      failed++;
      console.error(
        JSON.stringify({ event: 'recovery_due_check_failed', family: RECOVERY_FAMILIES[index] })
      );
      continue;
    }
    const { family, due } = check.value;
    if (!due) continue;
    eligible++;
    if (activeTasks.has(family)) continue;
    try {
      const run = await ensureMaintenanceRun(env, family, bucket, context.cutoff, clock);
      if (run) {
        runs.set(run.id, run);
        activeTasks.add(family);
      }
    } catch {
      failed++;
      console.error(JSON.stringify({ event: 'recovery_run_create_failed', family }));
    }
  }
  const dueRuns = [...runs.values()].filter((run) => runnable(run, clock));
  const deliveries = await Promise.allSettled(
    dueRuns.map((run) => dispatch(env, run.task, run.id))
  );
  let queued = 0;
  for (const delivery of deliveries) {
    if (delivery.status === 'fulfilled' && delivery.value) queued++;
    else failed++;
  }
  console.warn(
    JSON.stringify({
      event: 'maintenance_backlog',
      due: dueRuns.length,
      eligibleFamilies: eligible,
      queued,
      failed,
      oldestDueAgeSeconds: dueRuns.length
        ? Math.max(
            ...dueRuns.map((r) => Math.round((Date.parse(clock) - Date.parse(r.next_at)) / 1000))
          )
        : 0,
      oldestUnfinishedAgeSeconds: rows.results.length
        ? Math.max(
            ...rows.results.map((r) =>
              Math.round((Date.parse(clock) - Date.parse(r.started_at)) / 1000)
            )
          )
        : 0,
    })
  );
  return { queued, failed };
}

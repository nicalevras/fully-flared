import { getSettings } from './settings';
import { operationalRecipients } from './outbox';
import type { StoreLimits } from '../schemas/limits';

export const RECOVERY_FAMILIES = [
  'reservation-expiry',
  'order-expiry',
  'webhook-recovery',
  'checkout-preparation',
  'authorization-recovery',
  'outbox-recovery',
  'refund-recovery',
] as const;
export type RecoveryFamily = (typeof RECOVERY_FAMILIES)[number];
export type RecoveryContext = {
  clock: string;
  cutoff: string;
  limits: StoreLimits;
  recipients: string[];
};
type Predicate = { sql: string; values: (string | number)[] };
const before = (clock: string, minutes: number) =>
  new Date(Date.parse(clock) - minutes * 60_000).toISOString();

/** One captured clock/settings/recipient snapshot for selection and due checks. */
export async function recoveryContext(
  db: D1Database,
  cutoff?: string,
  clock = new Date().toISOString()
): Promise<RecoveryContext> {
  const [settings, recipients] = await Promise.allSettled([
    getSettings(db),
    operationalRecipients(db),
  ]);
  if (settings.status === 'rejected') throw settings.reason;
  if (recipients.status === 'rejected')
    console.error(JSON.stringify({ event: 'recovery_alert_recipient_lookup_failed' }));
  return {
    clock,
    cutoff: cutoff ?? clock,
    limits: settings.value.limits,
    recipients: recipients.status === 'fulfilled' ? recipients.value : [],
  };
}

export function reservationDue(c: RecoveryContext): Predicate {
  return {
    sql: `r.status='active' AND r.expires_at<? AND NOT EXISTS(SELECT 1 FROM checkout_intents ci
      WHERE ci.order_id=r.order_id AND ci.flow='manual_capture' AND ci.allocation_id IS NOT NULL
      AND ci.payment_state NOT IN ('canceled','finalized'))`,
    values: [c.cutoff],
  };
}

export function pendingOrderDue(c: RecoveryContext): Predicate {
  return {
    sql: `o.status='pending_payment' AND o.created_at<?
      AND NOT EXISTS(SELECT 1 FROM checkout_intents ci WHERE ci.order_id=o.id AND ci.flow='manual_capture')
      AND NOT EXISTS(SELECT 1 FROM reservations r WHERE r.order_id=o.id AND r.status='active')
      AND NOT(o.payment_status='unpaid' AND o.stripe_payment_intent_id IS NOT NULL)`,
    values: [before(c.cutoff, c.limits.checkout_session_minutes + 18)],
  };
}

export function webhookDue(c: RecoveryContext): Predicate {
  return {
    sql: `w.received_at<=? AND ((w.status='failed' AND w.attempts<5 AND (w.retry_after IS NULL OR w.retry_after<=?))
      OR (w.status='pending' AND w.received_at<?)
      OR (w.status='dead' AND (w.retry_after IS NULL OR w.retry_after<=?)))`,
    values: [c.cutoff, c.cutoff, before(c.clock, 5), c.cutoff],
  };
}

export function preparationDue(c: RecoveryContext): Predicate {
  return {
    sql: `ci.created_at<=? AND ci.state IN ('reserved','session_creating','reconciliation_required')
      AND (ci.next_reconcile_at IS NULL OR ci.next_reconcile_at<=?)
      AND (ci.claim_expires_at IS NULL OR ci.claim_expires_at<=?)`,
    values: [c.cutoff, c.cutoff, c.clock],
  };
}

export function authorizationDue(c: RecoveryContext): Predicate {
  return {
    sql: `ci.flow='manual_capture' AND ci.created_at<=? AND ci.payment_state NOT IN ('finalized','canceled')
      AND (ci.payment_next_at<=? OR (ci.payment_next_at IS NULL AND ci.payment_claim_expires_at<=?))
      AND (ci.payment_claim_expires_at IS NULL OR ci.payment_claim_expires_at<=?)`,
    values: [c.cutoff, c.cutoff, c.clock, c.clock],
  };
}

export function authorizationAlertId(
  c: RecoveryContext,
  id: string,
  authorizedAt: string,
  to: string
) {
  return `authorization-${authorizedAt < before(c.clock, 15) ? 'escalated' : 'overdue'}-${id}-${to}`;
}

export function authorizationAlertDue(c: RecoveryContext): Predicate {
  return {
    sql: `ci.flow='manual_capture' AND ci.created_at<=? AND ci.payment_state NOT IN ('finalized','canceled')
      AND ci.authorized_at IS NOT NULL AND ci.authorized_at<?
      AND EXISTS(SELECT 1 FROM json_each(?) recipient WHERE NOT EXISTS(SELECT 1 FROM outbox alert
        WHERE alert.id=(CASE WHEN ci.authorized_at<? THEN 'authorization-escalated-' ELSE 'authorization-overdue-' END)||ci.id||'-'||recipient.value))`,
    values: [c.cutoff, before(c.clock, 5), JSON.stringify(c.recipients), before(c.clock, 15)],
  };
}

/** Sending recovery matches processOutboxRow's ten-minute claim timeout. */
export function outboxDue(c: RecoveryContext): Predicate {
  return {
    sql: `o.created_at<=? AND o.attempts<3 AND (
      (o.status IN ('pending','failed') AND (o.retry_after IS NULL OR o.retry_after<=?))
      OR (o.status='sending' AND o.claimed_at<?))`,
    values: [c.cutoff, c.cutoff, before(c.clock, 10)],
  };
}

export function refundDue(c: RecoveryContext): Predicate {
  return {
    sql: `r.created_at<=? AND r.status IN ('uncertain','pending','requires_action')
      AND r.attempts<? AND (r.retry_after IS NULL OR r.retry_after<=?)`,
    values: [c.cutoff, c.limits.refund_retry_cap, c.cutoff],
  };
}

export function refundAlertDue(c: RecoveryContext): Predicate {
  return {
    sql: `r.created_at<=? AND r.status IN ('uncertain','pending','requires_action')
      AND (r.attempts>=? OR r.created_at<?)
      AND EXISTS(SELECT 1 FROM json_each(?) recipient WHERE NOT EXISTS(SELECT 1 FROM outbox alert
        WHERE alert.id='refund-stuck-'||r.id||'-'||recipient.value))`,
    values: [
      c.cutoff,
      c.limits.refund_retry_cap,
      before(c.clock, c.limits.refund_stuck_minutes),
      JSON.stringify(c.recipients),
    ],
  };
}

export async function recoveryFamilyDue(
  db: D1Database,
  family: RecoveryFamily,
  c: RecoveryContext
): Promise<boolean> {
  let source: string, predicate: Predicate;
  switch (family) {
    case 'reservation-expiry':
      source = 'reservations r';
      predicate = reservationDue(c);
      break;
    case 'order-expiry':
      source = 'orders o';
      predicate = pendingOrderDue(c);
      break;
    case 'webhook-recovery':
      source = 'webhook_inbox w';
      predicate = webhookDue(c);
      break;
    case 'checkout-preparation':
      source = 'checkout_intents ci';
      predicate = preparationDue(c);
      break;
    case 'authorization-recovery': {
      source = 'checkout_intents ci';
      const retry = authorizationDue(c),
        alert = authorizationAlertDue(c);
      predicate = {
        sql: `(${retry.sql}) OR (${alert.sql})`,
        values: [...retry.values, ...alert.values],
      };
      break;
    }
    case 'outbox-recovery':
      source = 'outbox o';
      predicate = outboxDue(c);
      break;
    case 'refund-recovery': {
      source = 'refunds r';
      const retry = refundDue(c),
        alert = refundAlertDue(c);
      predicate = {
        sql: `(${retry.sql}) OR (${alert.sql})`,
        values: [...retry.values, ...alert.values],
      };
      break;
    }
  }
  return Boolean(
    await db
      .prepare(`SELECT 1 FROM ${source} WHERE ${predicate.sql} LIMIT 1`)
      .bind(...predicate.values)
      .first()
  );
}

import { sha256Hex } from '../lib/hash';
import { cancelOrdersStatements } from './order-cancellation';
import type { CheckoutRequest, PaymentProvider } from './payments';
import { acquireCheckoutPermit, type AdmissionStub } from './checkout-admission';
import { operationalRecipients, commitWithEmails, emailStatement } from './email';

// Durable checkout initiation (Phase 1). One intent per logical purchase
// attempt: retries, double-clicks and worker crashes resume the same
// operation instead of minting new orders, reservations or Stripe calls.

const now = () => new Date().toISOString();
const iso = (ms: number) => new Date(ms).toISOString();

export const GUEST_CAPABILITY_COOKIE = 'guest_checkout';

export type CheckoutIntentRow = {
  id: string;
  order_id: string;
  owner_type: 'account' | 'guest';
  user_id: string | null;
  guest_capability_hash: string | null;
  fingerprint: string;
  state: string;
  provider_payload_json: string;
  stripe_coupon_id: string | null;
  stripe_session_id: string | null;
  checkout_url: string | null;
  claim_token: string | null;
  claim_expires_at: string | null;
  fencing: number;
  session_expires_at: string;
  next_reconcile_at: string | null;
  failure_code: string | null;
  first_provider_attempt_at: string | null;
  provider_step: string | null;
  creation_stopped_at: string | null;
  created_at: string;
};

/** Canonical request fingerprint: merged, sorted SKU quantities plus
 *  normalized email, destination, rate and coupon. Ephemeral fields
 *  (Turnstile tokens) are excluded so legitimate retries match. */
export async function checkoutFingerprint(input: {
  email: string;
  lines: { sku: string; qty: number }[];
  shippingCountry: string;
  shippingRateId: string;
  discountCode?: string | undefined;
}): Promise<string> {
  const merged = new Map<string, number>();
  for (const l of input.lines) merged.set(l.sku, (merged.get(l.sku) ?? 0) + l.qty);
  const canonical = JSON.stringify({
    email: input.email.trim().toLowerCase(),
    lines: [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    country: input.shippingCountry,
    rate: input.shippingRateId,
    coupon: (input.discountCode ?? '').trim().toUpperCase(),
  });
  return sha256Hex(canonical);
}

export function parseGuestCapability(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === GUEST_CAPABILITY_COOKIE && rest.length) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function guestCapabilityCookieHeader(token: string, secure: boolean): string {
  return `${GUEST_CAPABILITY_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure ? '; Secure' : ''}`;
}

export async function loadIntent(
  db: D1Database,
  intentId: string
): Promise<CheckoutIntentRow | null> {
  return db
    .prepare(
      'SELECT id, order_id, owner_type, user_id, guest_capability_hash, fingerprint, state, provider_payload_json, stripe_coupon_id, stripe_session_id, checkout_url, claim_token, claim_expires_at, fencing, session_expires_at, next_reconcile_at, failure_code, first_provider_attempt_at, provider_step, creation_stopped_at, created_at FROM checkout_intents WHERE id = ?'
    )
    .bind(intentId)
    .first<CheckoutIntentRow>();
}

/** Ownership is proven by account identity or the hashed guest
 *  capability. Intent ID, email or order ID alone never authorize. */
export async function intentOwnedBy(
  row: CheckoutIntentRow,
  who: { userId: string | null; guestToken: string | null }
): Promise<boolean> {
  if (row.owner_type === 'account') return Boolean(who.userId) && row.user_id === who.userId;
  if (!who.guestToken || !row.guest_capability_hash) return false;
  return (await sha256Hex(who.guestToken)) === row.guest_capability_hash;
}

export type IntentOperationResult =
  | { status: 'ready'; checkoutUrl: string }
  | { status: 'already_paid' }
  | { status: 'pending' }
  | { status: 'canceled' }
  | { status: 'expired' };

const CLAIM_MS = 2 * 60_000;
const RECONCILE_DELAY_MS = 60_000;

/** Definite provider rejections (4xx validation/card errors, except
 *  408/409/429) created no payable session and are safe to cancel.
 *  409 means a concurrent request with the same idempotency key may
 *  still be executing (Stripe error guidance), so it is ambiguous like
 *  timeouts, connection loss, 429 and 5xx: the session may exist, the
 *  intent parks in reconciliation and replays the same operation. */
export function isDefiniteProviderRejection(error: unknown): boolean {
  const e = error as { statusCode?: unknown; type?: unknown };
  if (typeof e?.statusCode === 'number')
    return (
      e.statusCode >= 400 &&
      e.statusCode < 500 &&
      e.statusCode !== 408 &&
      e.statusCode !== 409 &&
      e.statusCode !== 429
    );
  return e?.type === 'StripeInvalidRequestError' || e?.type === 'StripeCardError';
}

const CREATION_HORIZON_MS = 23 * 60 * 60_000;

function claimGuard(
  db: D1Database,
  id: string,
  claim: { token: string; fencing: number; orderId: string }
) {
  return db
    .prepare(
      `INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(
    SELECT 1 FROM checkout_intents WHERE id=? AND claim_token=? AND fencing=? AND order_id=? AND claim_expires_at>? AND state='session_creating')`
    )
    .bind(id, claim.token, claim.fencing, claim.orderId, now());
}

async function parkForReconciliation(
  db: D1Database,
  intentId: string,
  claim: { token: string; fencing: number; orderId: string },
  failureCode: string,
  stopCreation = false
): Promise<void> {
  const at = now();
  const recipients = stopCreation ? await operationalRecipients(db) : [];
  const identities = recipients.map((to) => `checkout-unresolved-${intentId}-${to}`);
  await commitWithEmails(
    db,
    [
      claimGuard(db, intentId, claim),
      db
        .prepare(
          `UPDATE checkout_intents SET state='reconciliation_required',claim_token=NULL,claim_expires_at=NULL,
      next_reconcile_at=?,failure_code=?,creation_stopped_at=CASE WHEN ? THEN COALESCE(creation_stopped_at,?) ELSE creation_stopped_at END,updated_at=? WHERE id=?`
        )
        .bind(
          iso(Date.now() + (stopCreation ? 6 * 60 * 60_000 : RECONCILE_DELAY_MS)),
          failureCode,
          stopCreation ? 1 : 0,
          at,
          at,
          intentId
        ),
      ...recipients.map((to, i) =>
        emailStatement(db, identities[i]!, {
          to,
          subject: 'Checkout needs manual reconciliation',
          text: `Checkout intent ${intentId} needs provider reconciliation. Creation has stopped; no replacement was created.`,
          html: '<p>A checkout needs provider reconciliation. Creation has stopped; no replacement was created.</p>',
        })
      ),
    ],
    identities
  );
}

async function claimIntent(
  db: D1Database,
  intentId: string
): Promise<{ token: string; fencing: number; orderId: string } | null> {
  const token = crypto.randomUUID();
  const result = await db
    .prepare(
      `UPDATE checkout_intents SET state='session_creating',claim_token=?,claim_expires_at=?,fencing=fencing+1,updated_at=?
    WHERE id=? AND state IN ('reserved','session_creating','reconciliation_required','ready') AND (claim_expires_at IS NULL OR claim_expires_at<=?)`
    )
    .bind(token, iso(Date.now() + CLAIM_MS), now(), intentId, now())
    .run();
  if (!(result.meta.changes ?? 0)) return null;
  const row = await loadIntent(db, intentId);
  return row?.claim_token === token ? { token, fencing: row.fencing, orderId: row.order_id } : null;
}

class CheckoutDeadline extends Error {}

/** Every local result is fenced; a provider result does not authorize a stale worker. */
export async function runIntentOperation(
  db: D1Database,
  provider: PaymentProvider,
  intentId: string,
  opts?: { deadlineMs?: number }
): Promise<IntentOperationResult> {
  const intent = await loadIntent(db, intentId);
  if (!intent) return { status: 'canceled' };
  if (intent.state === 'canceled' || intent.state === 'expired') return { status: intent.state };
  const order = await db
    .prepare('SELECT status,payment_status,stripe_checkout_session_id FROM orders WHERE id=?')
    .bind(intent.order_id)
    .first<{ status: string; payment_status: string; stripe_checkout_session_id: string | null }>();
  if (!order) return { status: 'canceled' };
  if (['paid', 'partially_refunded', 'refunded', 'disputed'].includes(order.payment_status))
    return { status: 'already_paid' };
  const payable = order.status === 'pending_payment';
  if (
    intent.state === 'ready' &&
    intent.checkout_url &&
    payable &&
    intent.session_expires_at > now()
  )
    return { status: 'ready', checkoutUrl: intent.checkout_url };
  const claim = await claimIntent(db, intentId);
  if (!claim) return { status: 'pending' };
  const deadline = opts?.deadlineMs ?? Date.now() + 30_000;
  const callOptions = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CheckoutDeadline();
    return { timeoutMs: Math.min(10_000, remaining) };
  };
  try {
    const payload = JSON.parse(intent.provider_payload_json) as CheckoutRequest;
    const sessionId = intent.stripe_session_id ?? order.stripe_checkout_session_id;
    let session: { sessionId: string; url: string } | null = null;
    if (sessionId) {
      if (!provider.retrieveCheckoutSession)
        throw new Error('Provider session retrieval unavailable');
      const found = await provider.retrieveCheckoutSession(sessionId, callOptions());
      if (
        found &&
        (found.id !== sessionId ||
          (found.metadata?.order_id && found.metadata.order_id !== intent.order_id) ||
          (found.metadata?.attempt_id && found.metadata.attempt_id !== intentId))
      )
        throw new Error('Provider session identity mismatch');
      if (
        found &&
        (found.payment_status === 'paid' || found.payment_status === 'no_payment_required')
      ) {
        await rememberProviderSession(db, {
          ...found,
          metadata: { order_id: intent.order_id, attempt_id: intentId },
        });
        await parkForReconciliation(db, intentId, claim, 'settlement_pending', true);
        return { status: 'pending' };
      }
      if (!found) throw new Error('Known provider session could not be resolved');
      if (found?.status === 'open' && found.url && payable)
        session = { sessionId: found.id, url: found.url };
      else if (found) {
        await parkForReconciliation(db, intentId, claim, 'provider_unresolved', true);
        return { status: payable ? 'pending' : 'canceled' };
      }
    }
    const creationBlocked = () =>
      Boolean(intent.creation_stopped_at) ||
      !payable ||
      !Number.isFinite(Date.parse(intent.created_at)) ||
      Date.now() - Date.parse(intent.created_at) >= CREATION_HORIZON_MS ||
      !Number.isFinite(Date.parse(intent.session_expires_at)) ||
      Date.parse(intent.session_expires_at) < Date.now() + 30 * 60_000;
    const stopped = creationBlocked();
    if (!session && stopped) {
      await parkForReconciliation(db, intentId, claim, 'provider_unresolved', true);
      return { status: payable ? 'pending' : 'canceled' };
    }
    const beforeCreation = async (step: 'coupon' | 'session') => {
      if (creationBlocked()) throw new Error('Creation parameters no longer valid');
      const options = callOptions();
      await db.batch([
        claimGuard(db, intentId, claim),
        db
          .prepare(
            `UPDATE checkout_intents
        SET first_provider_attempt_at=COALESCE(first_provider_attempt_at,?),provider_step=?,updated_at=? WHERE id=?`
          )
          .bind(now(), step, now(), intentId),
      ]);
      return { ...options, ...callOptions() };
    };
    let couponId = intent.stripe_coupon_id ?? undefined;
    if (!session && !couponId && payload.discountCents && provider.createCoupon) {
      couponId = await provider.createCoupon(payload, await beforeCreation('coupon'));
      await db.batch([
        claimGuard(db, intentId, claim),
        db
          .prepare('UPDATE checkout_intents SET stripe_coupon_id=?,updated_at=? WHERE id=?')
          .bind(couponId, now(), intentId),
      ]);
    }
    if (!session) {
      const options = await beforeCreation('session');
      session = provider.createCheckoutSession
        ? await provider.createCheckoutSession(payload, couponId, options)
        : await provider.createCheckout(payload, options);
    }
    await db.batch([
      claimGuard(db, intentId, claim),
      db
        .prepare(
          `INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM orders WHERE id=?
        AND status='pending_payment' AND payment_status IN ('unpaid','failed')
        AND (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id=?)
        AND EXISTS(SELECT 1 FROM checkout_intents WHERE id=? AND (stripe_session_id IS NULL OR stripe_session_id=?)))`
        )
        .bind(intent.order_id, session.sessionId, intentId, session.sessionId),
      db
        .prepare('UPDATE orders SET stripe_checkout_session_id=?,updated_at=? WHERE id=?')
        .bind(session.sessionId, now(), intent.order_id),
      db
        .prepare(
          `UPDATE checkout_intents SET state='ready',stripe_session_id=?,checkout_url=?,claim_token=NULL,claim_expires_at=NULL,failure_code=NULL,updated_at=? WHERE id=?`
        )
        .bind(session.sessionId, session.url, now(), intentId),
    ]);
    return { status: 'ready', checkoutUrl: session.url };
  } catch (error) {
    const current = await loadIntent(db, intentId);
    if (
      current?.claim_token !== claim.token ||
      current.fencing !== claim.fencing ||
      !current.claim_expires_at ||
      current.claim_expires_at <= now()
    ) {
      console.warn(JSON.stringify({ event: 'checkout_intent_stale_worker_ignored', intentId }));
      return { status: 'pending' };
    }
    // A failed retrieval never proves that a known session was not created.
    if (
      isDefiniteProviderRejection(error) &&
      !(intent.stripe_session_id ?? order.stripe_checkout_session_id)
    ) {
      await db.batch([
        claimGuard(db, intentId, claim),
        db
          .prepare(
            `INSERT INTO batch_guard SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM orders WHERE id=? AND status IN ('pending_payment','canceled') AND payment_status IN ('unpaid','failed'))`
          )
          .bind(intent.order_id),
        ...cancelOrdersStatements(db, { sql: 'id=?', values: [intent.order_id] }),
        db
          .prepare(
            `UPDATE checkout_intents SET state='canceled',claim_token=NULL,claim_expires_at=NULL,failure_code='provider_rejected',updated_at=? WHERE id=?`
          )
          .bind(now(), intentId),
      ]);
      console.error(JSON.stringify({ event: 'checkout_intent_provider_rejected', intentId }));
      return { status: 'canceled' };
    }
    await parkForReconciliation(
      db,
      intentId,
      claim,
      error instanceof CheckoutDeadline ? 'deadline_exceeded' : 'provider_uncertain'
    );
    console.error(
      JSON.stringify({
        event: 'checkout_intent_uncertain',
        intentId,
        error: error instanceof Error ? error.name : 'unknown',
      })
    );
    return { status: 'pending' };
  }
}

/** Called by the existing bounded provider scan, not a per-intent search. */
export async function rememberProviderSession(
  db: D1Database,
  session: import('./payments').StripeSessionLite
): Promise<void> {
  const attempt = session.metadata?.attempt_id;
  const orderId = session.metadata?.order_id;
  if (!attempt || !orderId) return;
  const result = await db
    .prepare(
      `UPDATE checkout_intents SET stripe_session_id=?,checkout_url=COALESCE(?,checkout_url),next_reconcile_at=NULL,updated_at=?
    WHERE id=? AND order_id=? AND (stripe_session_id IS NULL OR stripe_session_id=?)`
    )
    .bind(session.id, session.url ?? null, now(), attempt, orderId, session.id)
    .run();
  if (
    !(result.meta.changes ?? 0) ||
    !['paid', 'no_payment_required'].includes(session.payment_status)
  )
    return;
  const eventId = `reconcile-session-${session.id}-${session.payment_status}`;
  const payload = JSON.stringify({
    id: eventId,
    type: 'checkout.session.completed',
    data: { object: session },
  });
  await db
    .prepare(
      `INSERT OR IGNORE INTO webhook_inbox(id,provider,event_id,type,payload_json,received_at) VALUES(?,'stripe',?,'checkout.session.completed',?,?)`
    )
    .bind(crypto.randomUUID(), eventId, payload, now())
    .run();
  const { enqueueJob } = await import('./email');
  await enqueueJob({ type: 'webhook.process', eventId });
}

/** Bounded recovery sweep: resume due or unclaimed initiation work.
 *  Creation replays keep frozen parameters and stop before key expiry.
 *  Unresolved operations remain available to retrieval and reconciliation. */
export async function reconcileCheckoutIntents(
  db: D1Database,
  provider: PaymentProvider | null,
  limit = 20,
  admission?: { getByName(name: string): AdmissionStub }
): Promise<number> {
  if (!provider) return 0;
  const rows = await db
    .prepare(
      `SELECT id, state FROM checkout_intents
       WHERE state IN ('reserved', 'session_creating', 'reconciliation_required')
         AND (next_reconcile_at IS NULL OR next_reconcile_at <= ?)
         AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
       ORDER BY created_at ASC LIMIT ?`
    )
    .bind(now(), now(), limit)
    .all<{ id: string; state: string }>();
  let advanced = 0;
  for (const r of rows.results) {
    // Recovery fails closed when admission is missing, unavailable or full.
    const permit = await acquireCheckoutPermit(admission);
    if (permit.kind !== 'acquired') break;
    try {
      const result = await runIntentOperation(db, provider, r.id);
      // Count only real progress: a row that stays exactly as it was
      // (lost claim, not yet due) is not "advanced".
      const after = await loadIntent(db, r.id);
      if (result.status !== 'pending' || (after && after.state !== r.state)) advanced++;
    } catch {
      console.warn(JSON.stringify({ event: 'checkout_intent_reconcile_failed', intentId: r.id }));
    } finally {
      await permit.release();
    }
  }
  return advanced;
}

import { inboxStripeEvent, processInboxEvent } from '../../web/src/server/checkout';
import type { PaymentProvider } from '../../web/src/server/payments';

/** Test-only composition of the two production webhook steps the
 *  queue consumer runs (durable inbox, then process). Production code
 *  never processes inline: the route enqueues and the consumer calls
 *  processInboxEvent; this helper exists so suites can simulate a
 *  delivered-and-consumed event without a queue. */
export async function deliverStripeEvent(
  db: D1Database,
  provider: PaymentProvider,
  payload: string,
  signature: string
): Promise<boolean> {
  const { eventId, duplicate } = await inboxStripeEvent(db, provider, payload, signature);
  if (duplicate) return false;
  return processInboxEvent(db, eventId, provider);
}

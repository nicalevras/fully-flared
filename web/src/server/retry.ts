/**
 * Exponential backoff for durable retry loops (webhook inbox, outbox):
 * 60s, 120s, 240s, ... capped at one hour. Deterministic (no jitter) so
 * sweeps and tests can reason about exactly when a row becomes due; the
 * sweep volumes here are small enough that thundering-herd jitter is not
 * a concern.
 */
export function nextRetryIso(attempts: number, from = new Date()): string {
  const seconds = Math.min(60 * 2 ** Math.max(0, attempts - 1), 3_600);
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

// Admin realtime fan-out (Phase 5). Broadcasts are best-effort
// notifications that ride on top of durable transitions: the state
// change is already committed in D1 before this runs, and the admin
// UI re-reads on focus, so a failed broadcast is logged and dropped
// rather than queued or retried.
export async function broadcastAdminRealtime(
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const { workerEnv } = await import('./env');
    await workerEnv.REALTIME?.getByName('admin').broadcast(event, payload);
  } catch (error) {
    console.error(JSON.stringify({ event: 'realtime_broadcast_failed', error: String(error) }));
  }
}

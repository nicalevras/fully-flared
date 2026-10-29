import { createFileRoute } from '@tanstack/react-router';
import { inboxStripeEvent } from '../../../server/checkout';
import { WebhookSignatureError, getStripeProvider } from '../../../server/payments';
import { enqueueJob } from '../../../server/email';

const MAX_WEBHOOK_BYTES = 1024 * 1024;

export const Route = createFileRoute('/api/webhooks/stripe')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        const provider = getStripeProvider(env);
        if (!provider) return new Response('Stripe is not configured', { status: 503 });
        const signature = request.headers.get('stripe-signature');
        if (!signature) return new Response('Missing stripe-signature', { status: 400 });
        let eventId: string;
        let duplicate: boolean;
        try {
          let payload = '';
          const reader = request.body?.getReader();
          if (reader) {
            const decoder = new TextDecoder();
            let bytes = 0;
            try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > MAX_WEBHOOK_BYTES) {
                  await reader.cancel().catch(() => {});
                  return new Response('Webhook payload exceeds 1 MiB', { status: 413 });
                }
                payload += decoder.decode(chunk.value, { stream: true });
              }
              payload += decoder.decode();
            } finally {
              reader.releaseLock();
            }
          }
          ({ eventId, duplicate } = await inboxStripeEvent(env.DB, provider, payload, signature));
        } catch (err) {
          if (err instanceof WebhookSignatureError)
            return new Response('Webhook verification failed', { status: 400 });
          console.error(
            JSON.stringify({
              event: 'stripe_webhook_inbox_failed',
              error: err instanceof Error ? err.name : 'unknown',
            })
          );
          return new Response('Webhook could not be recorded', { status: 500 });
        }
        if (duplicate) return Response.json({ ok: true, duplicate: true });
        // Processing is queued so spikes smooth out in the Queue instead
        // of piling onto D1. There is deliberately no inline fallback
        // (Phase 6): the inbox row is the durable record, so on a queue
        // failure the event waits for the cron recovery sweep
        // (reprocessStaleInbox) rather than running financial work in
        // the request path. The delivery is still acknowledged — the
        // event is durable, and Stripe redeliveries get the duplicate
        // ack above instead of a retry storm.
        const queued = await enqueueJob({ type: 'webhook.process', eventId });
        if (!queued) console.error(JSON.stringify({ event: 'webhook_enqueue_deferred', eventId }));
        return Response.json({ ok: true, queued });
      },
    },
  },
});

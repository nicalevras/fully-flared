import { createFileRoute } from '@tanstack/react-router';
import { inboxStripeEvent } from '../../../server/checkout';
import { WebhookSignatureError, getStripeProvider } from '../../../server/payments';
import { enqueueJob } from '../../../server/email';

export const Route = createFileRoute('/api/webhooks/stripe')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { env } = await import('cloudflare:workers');
        const provider = getStripeProvider(env);
        if (!provider) return new Response('Stripe is not configured', { status: 503 });
        const signature = request.headers.get('stripe-signature');
        if (!signature) return new Response('Missing stripe-signature', { status: 400 });
        const payload = await request.text();
        let eventId: string;
        let duplicate: boolean;
        try {
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

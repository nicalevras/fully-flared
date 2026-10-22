export const REQUIRED_STRIPE_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.payment_failed',
  'refund.updated',
  'refund.failed',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
] as const;

export function stripeListenArguments(baseUrl: string): string[] {
  return [
    'listen',
    '--forward-to',
    new URL('/api/webhooks/stripe', baseUrl).href,
    '--events',
    REQUIRED_STRIPE_EVENTS.join(','),
  ];
}

export function missingStripeSubscriptions(enabled: string[]): string[] {
  return enabled.includes('*')
    ? []
    : REQUIRED_STRIPE_EVENTS.filter((type) => !enabled.includes(type));
}

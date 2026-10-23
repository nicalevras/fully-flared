import { REQUIRED_STRIPE_EVENTS } from '../server/stripe-events';
import * as z from 'zod';

// The Stripe event envelope we actually read. Payloads are parsed into this
// shape before any handler runs; handlers narrow on `type` exhaustively.
export const stripeEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.object({
    object: z.record(z.string(), z.unknown()),
  }),
});
export type StripeEventParsed = z.infer<typeof stripeEventSchema>;

// Metadata we set at Checkout session creation and read back in webhooks.
export const checkoutMetadataSchema = z.object({
  order_id: z.string().min(1),
  attempt_id: z.string().min(1).optional(),
});
export type CheckoutMetadata = z.infer<typeof checkoutMetadataSchema>;

export const stripeObjectIdSchema = z.object({
  id: z.string().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
  payment_intent: z.string().nullable().optional(),
  payment_status: z.string().optional(),
  amount_total: z.number().int().nullable().optional(),
  currency: z.string().optional(),
  status: z.string().optional(),
  shipping: z.unknown().optional(),
  customer_details: z.unknown().optional(),
  payment_method_types: z.array(z.string()).optional(),
  latest_charge: z.string().nullable().optional(),
  amount: z.number().int().optional(),
  amount_refunded: z.number().int().optional(),
  charge: z.string().optional(),
  payment_method_details: z.unknown().optional(),
});
export type StripeObjectParsed = z.infer<typeof stripeObjectIdSchema>;

export const shippingDetailsSchema = z.object({
  shipping_details: z
    .object({
      name: z.string().min(1).max(300),
      address: z.object({
        line1: z.string().min(1).max(500),
        line2: z.string().max(500).nullable().optional(),
        city: z.string().max(200).nullable().optional(),
        state: z.string().max(200).nullable().optional(),
        postal_code: z.string().max(50).nullable().optional(),
        country: z.string().regex(/^[A-Z]{2}$/),
      }),
    })
    .optional(),
});

const identity = z.object({ id: z.string().min(1) }).passthrough();
const checkoutPayment = identity.extend({
  payment_intent: z.string().nullable().optional(),
  payment_status: z.string(),
  amount_total: z.number().int().nonnegative(),
  currency: z.string().length(3),
  metadata: checkoutMetadataSchema.optional(),
});
const refund = identity.extend({
  payment_intent: z.string(),
  amount: z.number().int().positive(),
  status: z.enum(['pending', 'requires_action', 'succeeded', 'failed', 'canceled']),
});
export const handledStripeSchemas: Record<string, z.ZodType> = {
  'checkout.session.completed': checkoutPayment,
  'checkout.session.async_payment_succeeded': checkoutPayment,
  'checkout.session.async_payment_failed': identity,
  'checkout.session.expired': identity,
  'payment_intent.payment_failed': identity,
  'payment_intent.amount_capturable_updated': identity,
  'payment_intent.succeeded': identity,
  'payment_intent.canceled': identity,
  'refund.updated': refund,
  'refund.failed': refund.omit({ status: true }),
  'charge.refunded': identity.extend({
    payment_intent: z.string(),
    amount_refunded: z.number().int().nonnegative(),
  }),
  'charge.dispute.created': identity.extend({ payment_intent: z.string() }),
  'charge.dispute.closed': identity.extend({
    payment_intent: z.string(),
    status: z.enum(['won', 'lost', 'warning_closed']),
  }),
};

if (REQUIRED_STRIPE_EVENTS.some((type) => !handledStripeSchemas[type]))
  throw new Error('Stripe manifest is missing payload validation');

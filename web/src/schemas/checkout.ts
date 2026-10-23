import * as z from 'zod';
import { LIMIT_DEFINITIONS } from './limits';
import { emailString, idString, slugString } from './common';

export const checkoutLineSchema = z.object({
  sku: z.string().trim().min(1).max(100),
  qty: z.number().int().min(1).max(LIMIT_DEFINITIONS.cart_max_qty.max),
});

export const shippingAddressSchema = z.object({
  name: z.string().trim().min(1).max(300),
  line1: z.string().trim().min(1).max(500),
  line2: z.string().trim().max(500).default(''),
  city: z.string().trim().min(1).max(200),
  state: z.string().trim().max(200).default(''),
  postalCode: z.string().trim().min(1).max(50),
  country: z.string().regex(/^[A-Z]{2}$/),
  phone: z.string().trim().max(50).default(''),
});
export type ShippingAddress = z.infer<typeof shippingAddressSchema>;

export const checkoutBodySchema = z.object({
  // Durable client intent (Phase 1): one UUID per logical purchase
  // attempt, reused across double-clicks and retries.
  intentId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  cartId: z.string().uuid(),
  cartRevision: z.number().int().nonnegative(),
  // Commerce revision of the quote the shopper saw (Phase 2). When it no
  // longer matches, submission is rejected for requote instead of
  // silently charging changed pricing.
  quoteRevision: z.number().int().min(0).optional(),
  // The price breakdown from the quote the shopper confirmed. When
  // present, the server recomputes the authoritative quote from the
  // submitted lines/coupon/shipping selection and rejects any drift
  // with STALE_QUOTE instead of charging a different amount.
  confirmedQuote: z
    .object({
      subtotalCents: z.number().int().min(0).max(100_000_000),
      discountCents: z.number().int().min(0).max(100_000_000),
      shippingCents: z.number().int().min(0).max(100_000_000),
      totalCents: z.number().int().min(0).max(100_000_000),
    })
    .optional(),
  email: emailString,
  lines: z.array(checkoutLineSchema).min(1).max(100),
  discountCode: z.string().trim().max(64).optional(),
  shippingRateId: idString,
  shippingCountry: z.string().regex(/^[A-Z]{2}$/),
  shippingAddress: shippingAddressSchema.optional(),
  reminderConsent: z.boolean().optional().default(false),
  turnstileToken: z.string().max(2048).optional(),
  // successUrl/cancelUrl are deliberately absent: they are built on the
  // server from the configured base URL, never accepted from the client.
});

export const checkoutConfirmSchema = z.object({
  intentId: z.string().uuid(),
  quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CheckoutBody = z.infer<typeof checkoutBodySchema>;

// A price preview is not a checkout attempt: do not inherit ownership fields.
export const checkoutQuoteSchema = checkoutBodySchema.pick({
  email: true,
  lines: true,
  discountCode: true,
  shippingRateId: true,
  shippingCountry: true,
});

export const pricingBodySchema = z.object({
  skus: z.array(z.string().trim().min(1).max(100)).max(200),
});
export type PricingBody = z.infer<typeof pricingBodySchema>;

export const discountValidateBodySchema = z.object({
  code: z.string().trim().min(1).max(64),
  subtotalCents: z.number().int().min(0).max(100_000_000),
  email: emailString,
});
export type DiscountValidateBody = z.infer<typeof discountValidateBodySchema>;

export const returnCreateBodySchema = z.object({
  orderId: idString,
  reason: z.string().trim().max(500).optional().default(''),
  items: z
    .array(z.object({ orderItemId: idString, qty: z.number().int().min(1) }))
    .min(1)
    .max(100),
});
export type ReturnCreateBody = z.infer<typeof returnCreateBodySchema>;

export const slugParamSchema = slugString;
export const collectionPageInputSchema = z.object({
  slug: slugString,
  page: z.number().int().min(1).max(100_000).catch(1).default(1),
});
export const collectionSearchSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).catch(1).default(1),
});
export const homePageInputSchema = z.object({
  page: z.number().int().min(1).max(100_000).catch(1).default(1),
});
export const searchQueryParamSchema = z.object({
  q: z.string().max(200).catch(''),
});
export const successSearchSchema = z.object({
  order: z.string().max(100).catch(''),
  t: z.string().max(200).catch(''),
});

export const successOrderInputSchema = z.object({
  orderId: idString,
  token: z.string().max(200).optional().default(''),
});

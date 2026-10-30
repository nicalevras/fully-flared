import * as z from 'zod';
import { LIMIT_DEFINITIONS } from '../lib/settings-definitions';
import { MAX_STOREFRONT_PAGE } from '../lib/search-params';
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

/** Validates a CheckoutRequest stored as JSON; unknown keys pass through. */
export const checkoutRequestSchema = z
  .object({
    orderId: z.string(),
    attemptId: z.string(),
    email: z.string(),
    currency: z.string(),
    lineItems: z.array(
      z.object({ name: z.string(), unitAmountCents: z.number(), qty: z.number() }).loose()
    ),
    discountCents: z.number().optional(),
    discountCode: z.string().optional(),
    shippingCents: z.number().optional(),
    successUrl: z.string(),
    cancelUrl: z.string(),
    collectShipping: z.boolean(),
    shippingCountries: z.array(z.string()),
    automaticTax: z.boolean(),
    expiresAtEpochSeconds: z.number(),
    shippingAddress: shippingAddressSchema.optional(),
    customerId: z.string().optional(),
  })
  .loose();

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
  page: z.number().int().min(1).max(MAX_STOREFRONT_PAGE).catch(1).default(1),
});
export const homePageInputSchema = z.object({
  page: z.number().int().min(1).max(MAX_STOREFRONT_PAGE).catch(1).default(1),
});

/** `live` asks a page loader for stock; only client navigation sets it, never SSR. */
const liveFlag = z.boolean().default(false);
export const productPageInputSchema = z.object({ slug: slugString, live: liveFlag });
export const homeInputSchema = z.object({ live: liveFlag });
export const shopPageInputSchema = homePageInputSchema.extend({ live: liveFlag });
export const liveCollectionPageInputSchema = collectionPageInputSchema.extend({ live: liveFlag });

export const successOrderInputSchema = z.object({
  orderId: idString,
  token: z.string().max(200).optional().default(''),
});

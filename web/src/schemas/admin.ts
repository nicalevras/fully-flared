import * as z from 'zod';
import { centsInt, emailString, idString, nonEmptyString, slugString } from './common';
import { MAX_RAILS } from '../server/catalog-models';

// Every admin action is one member of this discriminated union. The action
// switch receives only parsed, typed payloads — no str()/num() coercion of
// arbitrary JSON into '' or 0 anywhere downstream.
const text = (max = 500) => z.string().max(max);
const optText = (max = 500) => z.string().max(max).optional().default('');
const nullableCents = z.number().int().min(0).nullable().optional();
const featuredRank = z.number().int().min(1).max(MAX_RAILS).nullable().optional().default(null);

const variantInput = z.object({
  sku: nonEmptyString(100),
  title: nonEmptyString(200),
  priceCents: centsInt,
  continueSelling: z.boolean().optional().default(false),
  weightGrams: z.number().int().min(0).max(1_000_000).nullable().optional().default(null),
  stock: z.number().int().min(0).max(1_000_000).optional().default(0),
});

export const adminActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('product.create'),
    title: nonEmptyString(300),
    slug: slugString,
    description: text(20_000).optional().default(''),
    status: z.enum(['draft', 'active']).optional().default('draft'),
    seoTitle: optText(300),
    seoDescription: optText(500),
    taxCode: optText(100),
    variants: z.array(variantInput).min(1).max(100),
  }),
  z.object({
    action: z.literal('product.update'),
    productId: idString,
    title: nonEmptyString(300),
    slug: slugString,
    description: text(20_000),
    status: z.enum(['draft', 'active']),
    seoTitle: optText(300),
    seoDescription: optText(500),
    taxCode: optText(100),
  }),
  z.object({
    action: z.literal('product.updateStatus'),
    productId: idString,
    status: nonEmptyString(40),
  }),
  z.object({ action: z.literal('product.attachMedia'), productId: idString, mediaId: idString }),
  z.object({ action: z.literal('product.detachMedia'), productId: idString, mediaId: idString }),
  z.object({
    action: z.literal('variant.save'),
    variantId: z.string().max(100).optional().default(''),
    productId: idString,
    sku: nonEmptyString(100),
    title: optText(200),
    priceCents: centsInt,
    compareAtCents: nullableCents,
    continueSelling: z.boolean().optional().default(false),
    weightGrams: z.number().int().min(0).max(1_000_000).nullable().optional().default(null),
  }),
  z.object({ action: z.literal('variant.delete'), variantId: idString }),
  z.object({
    action: z.literal('variant.bulkUpdate'),
    variantIds: z.array(idString).min(1).max(50),
    priceCents: nullableCents,
    stockDelta: z.number().int().min(-1_000_000).max(1_000_000).optional().default(0),
  }),
  z.object({
    action: z.literal('stock.adjust'),
    sku: nonEmptyString(100),
    delta: z.number().int().min(-1_000_000).max(1_000_000),
    reason: z.enum(['restock', 'correction', 'damaged', 'return']).optional().default('restock'),
  }),
  z.object({ action: z.literal('media.updateAlt'), mediaId: idString, altText: text(500) }),
  z.object({ action: z.literal('media.delete'), mediaId: idString }),
  z
    .object({
      action: z.literal('discount.create'),
      code: nonEmptyString(64),
      type: z.enum(['percentage', 'fixed_amount']),
      value: z.number().int().min(0).max(100_000_000),
      minPurchaseCents: centsInt.optional().default(0),
      usageLimit: z.number().int().min(1).nullable().optional(),
      startsAt: z.string().max(40).nullable().optional(),
      expiresAt: z.string().max(40).nullable().optional(),
    })
    .refine((discount) => discount.type !== 'percentage' || discount.value <= 100, {
      path: ['value'],
      message: 'Percentage discounts must be between 0 and 100',
    }),
  z.object({ action: z.literal('discount.toggle'), discountId: idString, active: z.boolean() }),
  z.object({ action: z.literal('discount.delete'), discountId: idString }),
  z.object({
    action: z.literal('collection.create'),
    title: nonEmptyString(300),
    slug: slugString,
    description: text(5_000).optional().default(''),
    kind: z.enum(['manual', 'rule']).optional().default('manual'),
    ruleJson: optText(1_000),
    featuredRank,
  }),
  z.object({
    action: z.literal('collection.update'),
    collectionId: idString,
    title: nonEmptyString(300),
    description: text(5_000),
    seoTitle: optText(300),
    seoDescription: optText(500),
    kind: z.enum(['manual', 'rule']).optional().default('manual'),
    ruleJson: optText(1_000),
    featuredRank,
  }),
  z.object({ action: z.literal('collection.delete'), collectionId: idString }),
  z.object({
    action: z.literal('collection.setProducts'),
    collectionId: idString,
    productIds: z.array(idString).max(500),
  }),
  z.object({
    action: z.literal('collection.toggleProduct'),
    collectionId: idString,
    productId: idString,
    included: z.boolean(),
  }),
  z.object({
    action: z.literal('shipping.createZone'),
    name: nonEmptyString(200),
    countries: z
      .array(
        z
          .string()
          .trim()
          .length(2)
          .transform((s) => s.toUpperCase())
      )
      .min(1)
      .max(250),
  }),
  z.object({
    action: z.literal('shipping.addRate'),
    zoneId: idString,
    name: nonEmptyString(200),
    rateCents: centsInt,
    kind: z.enum(['flat', 'weight', 'free_over']).optional(),
    perKgCents: nullableCents,
    freeOverCents: nullableCents,
  }),
  z.object({
    action: z.literal('order.ship'),
    orderId: idString,
    trackingNumber: text(200),
    trackingUrl: optText(1000),
  }),
  z.object({
    action: z.literal('order.refund'),
    requestId: idString,
    orderId: idString,
    amountCents: z.number().int().min(1).optional(),
    restock: z.boolean().optional().default(false),
  }),
  z.object({
    action: z.literal('return.approve'),
    returnId: idString,
  }),
  z.object({
    action: z.literal('return.refund'),
    returnId: idString,
    amountCents: z.number().int().min(1),
  }),
  z.object({ action: z.literal('return.reject'), returnId: idString }),
  z.object({ action: z.literal('webhook.replay'), eventId: nonEmptyString(200) }),
  z.object({
    action: z.literal('settings.set'),
    key: nonEmptyString(100),
    value: z.string().max(2000),
  }),
  z.object({
    action: z.literal('page.save'),
    id: z.string().max(100).optional().default(''),
    slug: slugString,
    title: nonEmptyString(300),
    contentHtml: text(200_000),
    seoTitle: optText(300),
    seoDescription: optText(500),
  }),
  z.object({
    action: z.literal('post.save'),
    id: z.string().max(100).optional().default(''),
    slug: slugString,
    title: nonEmptyString(300),
    excerpt: text(2_000).optional().default(''),
    contentHtml: text(500_000),
    contentJson: optText(1_000_000),
    status: z.enum(['draft', 'published', 'scheduled']),
    seoTitle: optText(300),
    seoDescription: optText(500),
    tags: optText(500),
    coverMediaId: optText(100),
    publishedAt: optText(40),
  }),
  z.object({ action: z.literal('import.productsCsv'), csv: z.string().min(1).max(2_000_000) }),
  z.object({ action: z.literal('customer.export'), userId: idString }),
  z.object({ action: z.literal('customer.delete'), userId: idString }),
  z.object({
    action: z.literal('user.setRole'),
    userId: idString,
    role: z.enum(['customer', 'support', 'warehouse', 'manager', 'owner']),
  }),
]);

export type AdminActionInput = z.infer<typeof adminActionSchema>;
export type AdminActionName = AdminActionInput['action'];
export { emailString };

export type AdminAction = z.infer<typeof adminActionSchema>;

export const csvProductRowSchema = z.object({
  title: nonEmptyString(300),
  slug: slugString,
  sku: nonEmptyString(100),
  price: z.coerce.number().int().min(0).max(100_000_000),
  stockQty: z.coerce.number().int().min(0).max(1_000_000),
});

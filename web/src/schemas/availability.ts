import { z } from 'zod';

export const availabilityModeSchema = z.enum(['products', 'product']);
export type AvailabilityMode = z.infer<typeof availabilityModeSchema>;
export const availabilityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const variantAvailabilitySchema = z.object({
  sku: z.string(),
  available: z.number().int().nonnegative().nullable(),
  continueSelling: z.boolean(),
});
export const productAvailabilitySchema = z.object({
  id: availabilityIdSchema,
  status: z.enum(['in_stock', 'backorder', 'sold_out', 'unavailable']),
  variants: z.array(variantAvailabilitySchema).optional(),
});
export const availabilityResponseSchema = z.object({
  products: z.array(productAvailabilitySchema),
});
export type ProductAvailability = z.infer<typeof productAvailabilitySchema>;
export type VariantAvailability = z.infer<typeof variantAvailabilitySchema>;

export const availabilityInputSchema = z
  .object({
    mode: availabilityModeSchema,
    ids: z
      .array(availabilityIdSchema)
      .min(1)
      .max(200)
      .transform((ids) => [...new Set(ids)])
      .pipe(z.array(availabilityIdSchema).max(50)),
  })
  .refine(({ mode, ids }) => mode !== 'product' || ids.length === 1, 'Expected one product');
export type AvailabilityInput = z.input<typeof availabilityInputSchema>;
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;

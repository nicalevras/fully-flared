import { z } from 'zod';

// Keep offset arithmetic safe at the largest admin page size (200).
export const pageSchema = z
  .number()
  .int()
  .min(1)
  .max(Math.floor(Number.MAX_SAFE_INTEGER / 200))
  .optional()
  .catch(1)
  .default(1);
export const pageInputSchema = z.object({ page: pageSchema });
export const orderPagesSchema = pageInputSchema.extend({ returnsPage: pageSchema });
export const accountSearchSchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .max(Math.floor(Number.MAX_SAFE_INTEGER / 200))
    .catch(1)
    .default(1),
});

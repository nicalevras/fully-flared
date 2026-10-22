import * as z from 'zod';
import { LIMIT_DEFINITIONS } from './limits';

export const cartLineMutationSchema = z.object({
  sku: z.string().min(1).max(128),
  qty: z.number().int().min(0).max(LIMIT_DEFINITIONS.cart_max_qty.max),
});

export const cartAddSchema = z.object({
  sku: z.string().min(1).max(128),
  qty: z.number().int().min(1).max(LIMIT_DEFINITIONS.cart_max_qty.max),
});

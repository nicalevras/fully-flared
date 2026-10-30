import { z } from 'zod';
import { MAX_PAGE } from '../lib/search-params';

export const pageSchema = z.number().int().min(1).max(MAX_PAGE).optional().catch(1).default(1);
export const pageInputSchema = z.object({ page: pageSchema });
export const orderPagesSchema = pageInputSchema.extend({ returnsPage: pageSchema });

export const pageSizeSchema = z
  .union([z.literal(10), z.literal(20), z.literal(25), z.literal(50), z.literal(100)])
  .default(25);

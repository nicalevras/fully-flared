import { z } from 'zod';
import { MAX_PAGE } from '../lib/search-params';

export const pageSchema = z.number().int().min(1).max(MAX_PAGE).optional().catch(1).default(1);
export const pageInputSchema = z.object({ page: pageSchema });
export const orderPagesSchema = pageInputSchema.extend({ returnsPage: pageSchema });

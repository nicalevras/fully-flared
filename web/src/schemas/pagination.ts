import { z } from 'zod';
import { MAX_PAGE } from '../lib/search-params';

export const pageSchema = z.number().int().min(1).max(MAX_PAGE).optional().catch(1).default(1);
export const pageInputSchema = z.object({ page: pageSchema });
export const orderPagesSchema = pageInputSchema.extend({ returnsPage: pageSchema });

// Rows-per-page choices for admin Data Tables whose loaders accept a page size.
export const pageSizeOptions = [10, 20, 25, 50, 100] as const;
export type PageSize = (typeof pageSizeOptions)[number];
export const pageSizeSchema = z
  .union([z.literal(10), z.literal(20), z.literal(25), z.literal(50), z.literal(100)])
  .default(25);

export function isPageSize(value: unknown): value is PageSize {
  return typeof value === 'number' && (pageSizeOptions as readonly number[]).includes(value);
}

import * as z from 'zod';
import { emailString, idString } from './common';

const addressFields = {
  name: z.string().trim().min(1).max(200),
  line1: z.string().trim().min(1).max(300),
  line2: z.string().trim().max(300).optional().default(''),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).optional().default(''),
  postalCode: z.string().trim().min(1).max(32),
  country: z.string().trim().length(2).toUpperCase().default('US'),
  phone: z.string().trim().max(40).optional().default(''),
  isDefault: z.boolean().optional().default(false),
};

export const accountActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('address.create'), ...addressFields }),
  z.object({ action: z.literal('address.update'), addressId: idString, ...addressFields }),
  z.object({ action: z.literal('address.delete'), addressId: idString }),
  z.object({ action: z.literal('account.delete'), confirmEmail: emailString }),
]);
export type AccountAction = z.infer<typeof accountActionSchema>;
export type AccountActionInput = z.input<typeof accountActionSchema>;

export const reportQuerySchema = z.object({
  type: z
    .enum(['sales', 'products', 'inventory', 'orders', 'customers'])
    .optional()
    .default('sales'),
  format: z.enum(['json', 'csv']).optional().default('json'),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export const mediaUploadMetaSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  sizeBytes: z.number().int().min(1).max(MEDIA_MAX_BYTES),
});
export type MediaUploadMeta = z.infer<typeof mediaUploadMetaSchema>;

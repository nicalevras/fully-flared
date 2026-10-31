import { z } from 'zod';

export const exportTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  z.object({ kind: z.literal('account'), userId: z.string().min(1).max(200) }),
  z.object({
    kind: z.literal('guest'),
    email: z
      .email()
      .max(320)
      .transform((email) => email.toLowerCase()),
  }),
]);

export const exportRequestSchema = z.union([
  z.object({ target: exportTargetSchema }),
  z.object({ cursor: z.string().min(1).max(8000) }),
]);

export type ExportTarget = z.infer<typeof exportTargetSchema>;
export type ExportRequest = z.infer<typeof exportRequestSchema>;
export type ExportPage = { chunk: string; nextCursor: string | null };

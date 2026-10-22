import * as z from 'zod';
import { emailString } from './common';

// Queue messages and outbox payloads are a discriminated union on `type`.
// Anything that does not parse is poison: log it and ack, never retry-loop.
export const jobMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email.send'), outboxId: z.string().min(1) }),
  z.object({ type: z.literal('webhook.process'), eventId: z.string().min(1) }),
  z.object({ type: z.literal('catalog.rebuild') }),
]);
export type JobMessage = z.infer<typeof jobMessageSchema>;

export const emailMessageSchema = z.object({
  to: emailString,
  subject: z.string().min(1).max(300),
  text: z.string().min(1).max(50_000),
  html: z.string().min(1).max(200_000),
});
export type EmailMessageParsed = z.infer<typeof emailMessageSchema>;

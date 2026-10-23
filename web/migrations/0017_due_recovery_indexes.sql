CREATE INDEX `outbox_claim_due_idx` ON `outbox` (`status`,`claimed_at`,`id`) WHERE "outbox"."attempts"<3;--> statement-breakpoint
CREATE INDEX `refunds_age_due_idx` ON `refunds` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `refunds_attempt_due_idx` ON `refunds` (`status`,`attempts`,`id`);

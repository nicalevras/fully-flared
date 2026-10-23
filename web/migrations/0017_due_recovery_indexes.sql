CREATE INDEX `outbox_retry_due_idx` ON `outbox` (`status`,`retry_after`,`created_at`,`id`) WHERE "outbox"."attempts"<3;--> statement-breakpoint
CREATE INDEX `outbox_claim_due_idx` ON `outbox` (`status`,`claimed_at`,`id`) WHERE "outbox"."attempts"<3;--> statement-breakpoint
CREATE INDEX `refunds_retry_due_idx` ON `refunds` (`status`,`retry_after`,`id`);--> statement-breakpoint
CREATE INDEX `refunds_age_due_idx` ON `refunds` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `refunds_attempt_due_idx` ON `refunds` (`status`,`attempts`,`id`);--> statement-breakpoint
CREATE INDEX `webhook_pending_received_idx` ON `webhook_inbox` (`received_at`,`event_id`) WHERE "webhook_inbox"."status"='pending';
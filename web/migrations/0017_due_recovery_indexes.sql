CREATE INDEX `outbox_claim_due_idx` ON `outbox` (`status`,`claimed_at`,`id`) WHERE "outbox"."attempts"<3;--> statement-breakpoint
CREATE INDEX `refunds_age_due_idx` ON `refunds` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `refunds_attempt_due_idx` ON `refunds` (`status`,`attempts`,`id`);--> statement-breakpoint
CREATE TABLE `cache_purge_gate` (
	`id` integer PRIMARY KEY NOT NULL,
	`tokens` real NOT NULL,
	`refilled_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO cache_purge_gate(id,tokens,refilled_at) VALUES(1,25,0);
--> statement-breakpoint
ALTER TABLE `collections` ADD `featured_rank` integer;--> statement-breakpoint
CREATE INDEX `addresses_user_idx` ON `addresses` (`user_id`);--> statement-breakpoint
CREATE INDEX `orders_user_idx` ON `orders` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `returns_user_idx` ON `returns` (`user_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
PRAGMA optimize;

CREATE TABLE `checkout_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`user_id` text,
	`guest_capability_hash` text,
	`fingerprint` text NOT NULL,
	`state` text DEFAULT 'reserved' NOT NULL,
	`provider_payload_json` text NOT NULL,
	`payload_version` integer DEFAULT 1 NOT NULL,
	`coupon_idempotency_key` text NOT NULL,
	`session_idempotency_key` text NOT NULL,
	`stripe_coupon_id` text,
	`stripe_session_id` text,
	`checkout_url` text,
	`claim_token` text,
	`claim_expires_at` text,
	`fencing` integer DEFAULT 0 NOT NULL,
	`session_expires_at` text NOT NULL,
	`next_reconcile_at` text,
	`failure_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_intents_order_id_unique` ON `checkout_intents` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_intents_stripe_session_id_unique` ON `checkout_intents` (`stripe_session_id`);--> statement-breakpoint
CREATE INDEX `checkout_intents_owner_idx` ON `checkout_intents` (`user_id`,`guest_capability_hash`);--> statement-breakpoint
CREATE INDEX `checkout_intents_recovery_idx` ON `checkout_intents` (`state`,`next_reconcile_at`);--> statement-breakpoint
CREATE INDEX `checkout_intents_session_idx` ON `checkout_intents` (`stripe_session_id`);--> statement-breakpoint
ALTER TABLE `orders` ADD `checkout_intent_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `orders_checkout_intent_id_unique` ON `orders` (`checkout_intent_id`);
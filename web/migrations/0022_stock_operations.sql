CREATE TABLE `stock_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`sku` text NOT NULL,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`payload_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stock_operations_sku_idx` ON `stock_operations` (`sku`,`created_at`);
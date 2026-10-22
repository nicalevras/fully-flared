CREATE TABLE `catalog_cards` (
	`product_id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`card_json` text NOT NULL,
	`revision` text NOT NULL,
	`doc_revision` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_cards_slug_unique` ON `catalog_cards` (`slug`);--> statement-breakpoint
CREATE TABLE `catalog_invalidations` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `catalog_invalidations_created_idx` ON `catalog_invalidations` (`created_at`);--> statement-breakpoint
CREATE TABLE `catalog_listing_pages` (
	`listing_id` text NOT NULL,
	`generation` integer NOT NULL,
	`page` integer NOT NULL,
	`payload_json` text NOT NULL,
	`revision` text NOT NULL,
	PRIMARY KEY(`listing_id`, `generation`, `page`)
);
--> statement-breakpoint
CREATE INDEX `catalog_listing_pages_listing_idx` ON `catalog_listing_pages` (`listing_id`,`generation`,`page`);--> statement-breakpoint
CREATE TABLE `catalog_listings` (
	`listing_id` text NOT NULL,
	`generation` integer NOT NULL,
	`page_size` integer NOT NULL,
	`page_count` integer NOT NULL,
	`total` integer NOT NULL,
	`active` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`listing_id`, `generation`)
);
--> statement-breakpoint
CREATE INDEX `catalog_listings_active_idx` ON `catalog_listings` (`listing_id`,`active`);--> statement-breakpoint
CREATE TABLE `catalog_membership` (
	`listing_id` text NOT NULL,
	`product_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`listing_id`, `product_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `catalog_membership_listing_idx` ON `catalog_membership` (`listing_id`,`position`);--> statement-breakpoint
CREATE INDEX `catalog_membership_product_idx` ON `catalog_membership` (`product_id`);--> statement-breakpoint
CREATE TABLE `catalog_page_products` (
	`product_id` text NOT NULL,
	`listing_id` text NOT NULL,
	`generation` integer NOT NULL,
	`page` integer NOT NULL,
	PRIMARY KEY(`product_id`, `listing_id`, `generation`, `page`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `catalog_page_products_product_idx` ON `catalog_page_products` (`product_id`,`listing_id`);--> statement-breakpoint
CREATE TABLE `catalog_work` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`target_revision` integer DEFAULT 0 NOT NULL,
	`processed_revision` integer DEFAULT 0 NOT NULL,
	`build_token` text,
	`checkpoint` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_work_entity_unique` ON `catalog_work` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `catalog_work_due_idx` ON `catalog_work` (`processed_revision`,`next_attempt_at`);
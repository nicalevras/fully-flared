CREATE TABLE `catalog_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'full' NOT NULL,
	`state` text DEFAULT 'building' NOT NULL,
	`phase` text DEFAULT 'cards' NOT NULL,
	`state_json` text DEFAULT '{}' NOT NULL,
	`publication_seq` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `catalog_listing_page_revisions` (
	`listing_id` text NOT NULL,
	`generation` integer NOT NULL,
	`page` integer NOT NULL,
	`revision` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`listing_id`, `generation`, `page`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `catalog_listing_page_revisions_revision_idx` ON `catalog_listing_page_revisions` (`listing_id`,`generation`,`revision`);--> statement-breakpoint
CREATE TABLE `catalog_listing_ref_history` (
	`listing_id` text NOT NULL,
	`generation` integer NOT NULL,
	`publication_seq` integer NOT NULL,
	`root_hash` text NOT NULL,
	`page_count` integer NOT NULL,
	`total` integer NOT NULL,
	`page_size` integer NOT NULL,
	`retired_at` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`listing_id`, `generation`, `publication_seq`)
);
--> statement-breakpoint
CREATE TABLE `catalog_publication_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`publication_seq` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `catalog_ref_chunks` (
	`hash` text PRIMARY KEY NOT NULL,
	`listing_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `catalog_ref_state` (
	`ref_key` text PRIMARY KEY NOT NULL,
	`committed_seq` integer DEFAULT 0 NOT NULL,
	`delivered_seq` integer DEFAULT 0 NOT NULL,
	`root_hash` text,
	`last_write_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `catalog_publication_state` (`id`, `publication_seq`, `updated_at`) VALUES (1, 0, '1970-01-01T00:00:00.000Z');--> statement-breakpoint
-- Verified copy before the drop (reviewed exception in
-- scripts/check-migrations.mjs): every existing page payload moves to
-- the immutable revision table, keyed exactly as before.
INSERT INTO `catalog_listing_page_revisions` (`listing_id`, `generation`, `page`, `revision`, `payload_json`, `created_at`)
SELECT p.`listing_id`, p.`generation`, p.`page`, p.`revision`, p.`payload_json`, l.`updated_at`
FROM `catalog_listing_pages` p
JOIN `catalog_listings` l ON l.`listing_id` = p.`listing_id` AND l.`generation` = p.`generation`;--> statement-breakpoint
DROP TABLE `catalog_listing_pages`;--> statement-breakpoint
ALTER TABLE `catalog_cards` ADD `published_revision` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `catalog_listings` ADD `state` text DEFAULT 'active' NOT NULL;
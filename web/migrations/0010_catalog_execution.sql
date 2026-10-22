CREATE TABLE `catalog_build_listings` (
	`build_id` text NOT NULL,
	`listing_id` text NOT NULL,
	`generation` integer,
	`root_hash` text,
	`changed` integer,
	`page_count` integer,
	`total` integer,
	PRIMARY KEY(`build_id`, `listing_id`)
);
--> statement-breakpoint
CREATE TABLE `catalog_build_pages` (
	`build_id` text NOT NULL,
	`listing_id` text NOT NULL,
	`page` integer NOT NULL,
	`revision` text NOT NULL,
	PRIMARY KEY(`build_id`, `listing_id`, `page`)
);
--> statement-breakpoint
CREATE TABLE `catalog_documents` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`revision` text NOT NULL,
	`payload_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `catalog_ref_documents` (
	`ref_key` text NOT NULL,
	`publication_seq` integer NOT NULL,
	`document_key` text NOT NULL,
	PRIMARY KEY(`ref_key`, `publication_seq`, `document_key`)
);
--> statement-breakpoint
ALTER TABLE `catalog_builds` ADD `parent_id` text;--> statement-breakpoint
ALTER TABLE `catalog_builds` ADD `scope_listing_id` text;--> statement-breakpoint
ALTER TABLE `catalog_builds` ADD `source_revision` integer;--> statement-breakpoint
ALTER TABLE `catalog_publication_state` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `catalog_publication_state` ADD `lease_fencing` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `catalog_publication_state` ADD `lease_expires_at` text;--> statement-breakpoint
ALTER TABLE `catalog_ref_state` ADD `pending_payload` text;--> statement-breakpoint
ALTER TABLE `catalog_ref_state` ADD `delivery_retry_at` text;--> statement-breakpoint
ALTER TABLE `catalog_ref_state` ADD `delivery_failure` text;
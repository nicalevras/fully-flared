CREATE TABLE `catalog_artifacts` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`listing_id` text,
	`page` integer,
	`revision` text,
	`unreferenced_at` text,
	`mark_epoch` integer DEFAULT 0 NOT NULL,
	`deletion_pending` integer DEFAULT 0 NOT NULL,
	`retry_at` text,
	`failure` text
);
--> statement-breakpoint
CREATE INDEX `catalog_artifacts_retry_idx` ON `catalog_artifacts` (`retry_at`,`key`);--> statement-breakpoint
CREATE TABLE `catalog_gc_marks` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `catalog_gc_marks_pending_idx` ON `catalog_gc_marks` (`processed`,`kind`,`key`);--> statement-breakpoint
CREATE TABLE `catalog_gc_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`phase` text DEFAULT 'idle' NOT NULL,
	`step` integer DEFAULT 0 NOT NULL,
	`cursor` text DEFAULT '' NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`source_revision` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`next_run_at` text
);
--> statement-breakpoint
ALTER TABLE `catalog_publication_state` ADD `gc_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `catalog_ref_documents` ADD `retired_at` text;--> statement-breakpoint
CREATE INDEX `catalog_ref_documents_retired_idx` ON `catalog_ref_documents` (`retired_at`,`ref_key`,`publication_seq`,`document_key`);--> statement-breakpoint
CREATE INDEX `carts_retention_idx` ON `carts` (`status`,`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `catalog_builds_cleanup_idx` ON `catalog_builds` (`state`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `catalog_page_artifact_idx` ON `catalog_listing_page_revisions` (`listing_id`,`page`,`revision`,`generation`);--> statement-breakpoint
CREATE INDEX `catalog_history_retired_idx` ON `catalog_listing_ref_history` (`retired_at`,`listing_id`,`generation`,`publication_seq`);--> statement-breakpoint
CREATE INDEX `catalog_listings_cleanup_idx` ON `catalog_listings` (`active`,`updated_at`,`listing_id`,`generation`);--> statement-breakpoint
CREATE INDEX `catalog_page_products_generation_idx` ON `catalog_page_products` (`listing_id`,`generation`,`product_id`,`page`);--> statement-breakpoint
CREATE INDEX `checkout_intents_retention_idx` ON `checkout_intents` (`state`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `orders_ip_retention_idx` ON `orders` (`created_at`,`id`) WHERE "orders"."customer_ip" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `outbox_retention_idx` ON `outbox` (`status`,COALESCE("sent_at","created_at"),`id`);--> statement-breakpoint
CREATE INDEX `reservations_retention_idx` ON `reservations` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `webhook_inbox_retention_idx` ON `webhook_inbox` (`status`,COALESCE("processed_at","received_at"),`id`);
--> statement-breakpoint
INSERT INTO catalog_gc_state(id) VALUES(1);
--> statement-breakpoint
UPDATE catalog_ref_documents SET retired_at=COALESCE((SELECT h.retired_at FROM catalog_listing_ref_history h WHERE 'listing:'||h.listing_id=catalog_ref_documents.ref_key AND h.publication_seq=catalog_ref_documents.publication_seq LIMIT 1),strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE NOT EXISTS(SELECT 1 FROM catalog_ref_state r WHERE r.ref_key=catalog_ref_documents.ref_key AND r.committed_seq=catalog_ref_documents.publication_seq);
--> statement-breakpoint
CREATE TRIGGER catalog_gc_ref_insert AFTER INSERT ON catalog_ref_state WHEN 1 BEGIN UPDATE catalog_publication_state SET gc_revision=gc_revision+1 WHERE id=1; END;
--> statement-breakpoint
CREATE TRIGGER catalog_gc_ref_update AFTER UPDATE OF committed_seq,root_hash ON catalog_ref_state WHEN OLD.committed_seq IS NOT NEW.committed_seq OR OLD.root_hash IS NOT NEW.root_hash BEGIN UPDATE catalog_publication_state SET gc_revision=gc_revision+1 WHERE id=1; END;
--> statement-breakpoint
CREATE TRIGGER catalog_gc_ref_delete AFTER DELETE ON catalog_ref_state WHEN 1 BEGIN UPDATE catalog_publication_state SET gc_revision=gc_revision+1 WHERE id=1; END;
--> statement-breakpoint
CREATE TRIGGER catalog_gc_card_insert AFTER INSERT ON catalog_cards WHEN 1 BEGIN UPDATE catalog_publication_state SET gc_revision=gc_revision+1 WHERE id=1; END;
--> statement-breakpoint
CREATE TRIGGER catalog_gc_card_update AFTER UPDATE OF slug,doc_revision ON catalog_cards WHEN OLD.slug IS NOT NEW.slug OR OLD.doc_revision IS NOT NEW.doc_revision BEGIN UPDATE catalog_publication_state SET gc_revision=gc_revision+1 WHERE id=1; END;
--> statement-breakpoint
CREATE TRIGGER catalog_gc_card_delete AFTER DELETE ON catalog_cards WHEN 1 BEGIN UPDATE catalog_publication_state SET gc_revision=gc_revision+1 WHERE id=1; END;
--> statement-breakpoint
CREATE TRIGGER catalog_gc_pointer_insert AFTER INSERT ON catalog_documents WHEN NEW.kind LIKE '%-pointer' BEGIN UPDATE catalog_publication_state SET gc_revision=gc_revision+1 WHERE id=1; END;
--> statement-breakpoint
CREATE TRIGGER catalog_gc_pointer_update AFTER UPDATE OF payload_json ON catalog_documents WHEN NEW.kind LIKE '%-pointer' AND OLD.payload_json IS NOT NEW.payload_json BEGIN UPDATE catalog_publication_state SET gc_revision=gc_revision+1 WHERE id=1; END;
--> statement-breakpoint
CREATE TRIGGER catalog_gc_pointer_delete AFTER DELETE ON catalog_documents WHEN OLD.kind LIKE '%-pointer' BEGIN UPDATE catalog_publication_state SET gc_revision=gc_revision+1 WHERE id=1; END;
--> statement-breakpoint
CREATE TRIGGER catalog_ref_documents_retire AFTER UPDATE OF committed_seq ON catalog_ref_state WHEN OLD.committed_seq<>NEW.committed_seq BEGIN UPDATE catalog_ref_documents SET retired_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ref_key=NEW.ref_key AND publication_seq<>NEW.committed_seq AND retired_at IS NULL; END;
--> statement-breakpoint
CREATE TRIGGER catalog_ref_documents_retire_deleted AFTER DELETE ON catalog_ref_state BEGIN UPDATE catalog_ref_documents SET retired_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ref_key=OLD.ref_key AND retired_at IS NULL; END;

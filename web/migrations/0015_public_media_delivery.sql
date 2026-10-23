CREATE TABLE `media_variants` (
	`media_id` text NOT NULL,
	`width` integer NOT NULL,
	`r2_key` text NOT NULL,
	`public_url` text,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL,
	`ready` integer DEFAULT false NOT NULL,
	`upload_claim_until` text,
	`upload_claim_token` text,
	PRIMARY KEY(`media_id`, `width`),
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_variants_r2_key_unique` ON `media_variants` (`r2_key`);--> statement-breakpoint
ALTER TABLE `media` ADD `public_url` text;--> statement-breakpoint
CREATE INDEX `catalog_reference_verify_idx` ON `catalog_ref_state` (`verify_after`);
--> statement-breakpoint
CREATE TRIGGER media_variant_insert_guard BEFORE INSERT ON media_variants WHEN NEW.width NOT IN (320,640,960,1600) OR NEW.bytes<1 OR NEW.bytes>10485760 OR NOT EXISTS(SELECT 1 FROM media WHERE id=NEW.media_id AND deletion_pending=0 AND content_type=NEW.content_type) BEGIN SELECT RAISE(ABORT,'Invalid or pending media variant'); END;

--> statement-breakpoint
CREATE TRIGGER media_variant_update_guard BEFORE UPDATE OF media_id,width,r2_key,sha256,ready,public_url ON media_variants WHEN NEW.width!=OLD.width OR NEW.media_id!=OLD.media_id OR NEW.r2_key!=OLD.r2_key OR NEW.sha256!=OLD.sha256 OR NOT EXISTS(SELECT 1 FROM media WHERE id=NEW.media_id AND deletion_pending=0) BEGIN SELECT RAISE(ABORT,'Published variant is immutable or pending deletion'); END;

--> statement-breakpoint
CREATE TRIGGER media_variant_work_insert AFTER INSERT ON media_variants WHEN NEW.ready=1 BEGIN INSERT INTO catalog_work(id,entity_type,entity_id,target_revision,processed_revision,created_at,updated_at) VALUES('media:'||NEW.media_id,'media',NEW.media_id,1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(entity_type,entity_id) DO UPDATE SET target_revision=target_revision+1,updated_at=excluded.updated_at; END;

--> statement-breakpoint
CREATE TRIGGER media_variant_work_update AFTER UPDATE OF public_url,ready ON media_variants WHEN NEW.ready IS NOT OLD.ready OR NEW.public_url IS NOT OLD.public_url BEGIN INSERT INTO catalog_work(id,entity_type,entity_id,target_revision,processed_revision,created_at,updated_at) VALUES('media:'||NEW.media_id,'media',NEW.media_id,1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(entity_type,entity_id) DO UPDATE SET target_revision=target_revision+1,updated_at=excluded.updated_at; END;

--> statement-breakpoint
CREATE TRIGGER media_variant_work_delete AFTER DELETE ON media_variants WHEN OLD.ready=1 BEGIN INSERT INTO catalog_work(id,entity_type,entity_id,target_revision,processed_revision,created_at,updated_at) VALUES('media:'||OLD.media_id,'media',OLD.media_id,1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(entity_type,entity_id) DO UPDATE SET target_revision=target_revision+1,updated_at=excluded.updated_at; END;

--> statement-breakpoint
DROP TRIGGER catalog_work_settings_insert;

--> statement-breakpoint
CREATE TRIGGER catalog_work_settings_insert AFTER INSERT ON settings WHEN NEW.key IN ('store_name','announcement_text','media_public_base_url','seo_title_template','canonical_base_url','currency','checkout_email_cap','checkout_account_cap','checkout_ip_cap','cart_max_qty','cart_max_lines','order_max_units','checkout_session_minutes','refund_retry_cap','refund_stuck_minutes') BEGIN INSERT INTO catalog_work (id, entity_type, entity_id, target_revision, processed_revision, created_at, updated_at) VALUES ('settings:store', 'settings', 'store', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(entity_type, entity_id) DO UPDATE SET target_revision = target_revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'); END;

--> statement-breakpoint
DROP TRIGGER catalog_work_settings_update;

--> statement-breakpoint
CREATE TRIGGER catalog_work_settings_update AFTER UPDATE ON settings WHEN NEW.value IS NOT OLD.value AND NEW.key IN ('store_name','announcement_text','media_public_base_url','seo_title_template','canonical_base_url','currency','checkout_email_cap','checkout_account_cap','checkout_ip_cap','cart_max_qty','cart_max_lines','order_max_units','checkout_session_minutes','refund_retry_cap','refund_stuck_minutes') BEGIN INSERT INTO catalog_work (id, entity_type, entity_id, target_revision, processed_revision, created_at, updated_at) VALUES ('settings:store', 'settings', 'store', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(entity_type, entity_id) DO UPDATE SET target_revision = target_revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'); END;

--> statement-breakpoint
DROP TRIGGER catalog_work_settings_delete;

--> statement-breakpoint
CREATE TRIGGER catalog_work_settings_delete AFTER DELETE ON settings WHEN OLD.key IN ('store_name','announcement_text','media_public_base_url','seo_title_template','canonical_base_url','currency','checkout_email_cap','checkout_account_cap','checkout_ip_cap','cart_max_qty','cart_max_lines','order_max_units','checkout_session_minutes','refund_retry_cap','refund_stuck_minutes') BEGIN INSERT INTO catalog_work (id, entity_type, entity_id, target_revision, processed_revision, created_at, updated_at) VALUES ('settings:store', 'settings', 'store', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(entity_type, entity_id) DO UPDATE SET target_revision = target_revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'); END;

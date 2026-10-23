CREATE TABLE `media_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`media_id` text,
	`object_key` text NOT NULL,
	`public_url` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`claim_token` text,
	`claim_expires_at` text,
	`fencing` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_publications_public_url_unique` ON `media_publications` (`public_url`);--> statement-breakpoint
CREATE INDEX `media_publication_media_idx` ON `media_publications` (`media_id`,`state`);--> statement-breakpoint
ALTER TABLE `media` ADD `ready` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `media` ADD `upload_claim_token` text;--> statement-breakpoint
ALTER TABLE `media` ADD `upload_claim_until` text;
--> statement-breakpoint
-- Preserve known destinations. No inventory or financial data is rewritten.
INSERT INTO media_publications(id,media_id,object_key,public_url,state,updated_at)
SELECT 'original:'||id,id,r2_key,public_url,'ready',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM media WHERE public_url IS NOT NULL;
--> statement-breakpoint
INSERT INTO media_publications(id,media_id,object_key,public_url,state,updated_at)
SELECT 'variant:'||media_id||':'||width,media_id,r2_key,public_url,CASE WHEN ready=1 THEN 'ready' ELSE 'pending' END,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM media_variants WHERE public_url IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER media_publication_insert_guard BEFORE INSERT ON media_publications
WHEN NEW.state NOT IN ('pending','ready') OR NOT EXISTS(SELECT 1 FROM media WHERE id=NEW.media_id AND deletion_pending=0)
BEGIN SELECT RAISE(ABORT,'Media publication unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER media_publication_update_guard BEFORE UPDATE ON media_publications
WHEN NEW.object_key!=OLD.object_key OR NEW.public_url!=OLD.public_url
 OR (NEW.media_id IS NOT OLD.media_id AND NOT(NEW.media_id IS NULL AND NEW.state='deleted'))
 OR NEW.state NOT IN ('pending','ready','deleted') OR (OLD.state='deleted' AND NEW.state!='deleted')
 OR NEW.fencing<OLD.fencing
 OR (NEW.state='ready' AND OLD.state!='ready' AND NOT EXISTS(SELECT 1 FROM media WHERE id=NEW.media_id AND deletion_pending=0))
BEGIN SELECT RAISE(ABORT,'Media publication is immutable or pending deletion'); END;
--> statement-breakpoint
CREATE TRIGGER media_incomplete_product_insert BEFORE INSERT ON product_media
WHEN EXISTS(SELECT 1 FROM media WHERE id=NEW.media_id AND ready=0)
BEGIN SELECT RAISE(ABORT,'Image upload is incomplete'); END;
--> statement-breakpoint
CREATE TRIGGER media_incomplete_product_update BEFORE UPDATE OF media_id ON product_media
WHEN EXISTS(SELECT 1 FROM media WHERE id=NEW.media_id AND ready=0)
BEGIN SELECT RAISE(ABORT,'Image upload is incomplete'); END;
--> statement-breakpoint
CREATE TRIGGER media_incomplete_post_insert BEFORE INSERT ON posts
WHEN EXISTS(SELECT 1 FROM media WHERE id=NEW.cover_media_id AND ready=0)
BEGIN SELECT RAISE(ABORT,'Image upload is incomplete'); END;
--> statement-breakpoint
CREATE TRIGGER media_incomplete_post_update BEFORE UPDATE OF cover_media_id ON posts
WHEN EXISTS(SELECT 1 FROM media WHERE id=NEW.cover_media_id AND ready=0)
BEGIN SELECT RAISE(ABORT,'Image upload is incomplete'); END;
--> statement-breakpoint
CREATE TRIGGER media_ready_guard BEFORE UPDATE OF ready,public_url ON media
WHEN (NEW.ready=1 AND OLD.ready=0 AND (NEW.deletion_pending=1 OR NEW.upload_claim_token IS NULL OR NEW.upload_claim_until IS NULL OR NEW.upload_claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
 OR (NEW.public_url IS NOT NULL AND NEW.public_url IS NOT OLD.public_url AND NOT EXISTS(SELECT 1 FROM media_publications WHERE media_id=NEW.id AND object_key=NEW.r2_key AND public_url=NEW.public_url AND state='ready'))
BEGIN SELECT RAISE(ABORT,'Image publication is not ready'); END;
--> statement-breakpoint
CREATE TRIGGER media_variant_publication_guard BEFORE UPDATE OF public_url ON media_variants
WHEN NEW.public_url IS NOT NULL AND NEW.public_url IS NOT OLD.public_url AND NOT EXISTS(SELECT 1 FROM media_publications WHERE media_id=NEW.media_id AND object_key=NEW.r2_key AND public_url=NEW.public_url AND state='ready')
BEGIN SELECT RAISE(ABORT,'Image publication is not ready'); END;
--> statement-breakpoint
CREATE TRIGGER media_delete_publication_guard BEFORE DELETE ON media
WHEN EXISTS(SELECT 1 FROM media_publications WHERE media_id=OLD.id AND state!='deleted')
 OR OLD.upload_claim_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR EXISTS(SELECT 1 FROM media_variants WHERE media_id=OLD.id AND upload_claim_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'Image deletion cleanup is incomplete'); END;
--> statement-breakpoint
-- Upload leases are operational state, not catalog edits.
DROP TRIGGER catalog_work_media_update;
--> statement-breakpoint
CREATE TRIGGER catalog_work_media_update AFTER UPDATE OF alt_text,public_url,ready,r2_key,content_type,deletion_pending ON media
WHEN NEW.alt_text IS NOT OLD.alt_text OR NEW.public_url IS NOT OLD.public_url OR NEW.ready IS NOT OLD.ready
 OR NEW.r2_key IS NOT OLD.r2_key OR NEW.content_type IS NOT OLD.content_type OR NEW.deletion_pending IS NOT OLD.deletion_pending
BEGIN INSERT INTO catalog_work(id,entity_type,entity_id,target_revision,processed_revision,created_at,updated_at)
 VALUES('media:'||NEW.id,'media',NEW.id,1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 ON CONFLICT(entity_type,entity_id) DO UPDATE SET target_revision=target_revision+1,updated_at=excluded.updated_at; END;

CREATE TABLE `maintenance_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`cutoff` text NOT NULL,
	`progress_json` text DEFAULT '{}' NOT NULL,
	`next_at` text NOT NULL,
	`claim_token` text,
	`claim_expires_at` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `maintenance_due_idx` ON `maintenance_runs` (`state`,`next_at`);--> statement-breakpoint
CREATE INDEX `maintenance_task_idx` ON `maintenance_runs` (`task`,`state`);--> statement-breakpoint
ALTER TABLE `catalog_invalidations` ADD `ref_key` text;--> statement-breakpoint
ALTER TABLE `catalog_invalidations` ADD `ref_seq` integer;--> statement-breakpoint
ALTER TABLE `catalog_publication_state` ADD `work_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `catalog_ref_state` ADD `expected_payload` text;--> statement-breakpoint
ALTER TABLE `catalog_ref_state` ADD `verify_after` text;--> statement-breakpoint
ALTER TABLE `catalog_ref_state` ADD `verified_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `reminder_consent` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `reminder_suppressed_at` text;
--> statement-breakpoint
INSERT INTO settings(key,value,updated_at) VALUES('abandoned_reminders_enabled','0',strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO NOTHING;

--> statement-breakpoint
DROP TRIGGER commerce_revision_settings_insert;

--> statement-breakpoint
CREATE TRIGGER commerce_revision_settings_insert AFTER INSERT ON settings WHEN NEW.key IN ('currency','stripe_tax_enabled','stripe_tax_confirmed','checkout_email_cap','checkout_account_cap','checkout_ip_cap','cart_max_qty','cart_max_lines','order_max_units','checkout_session_minutes','refund_retry_cap','refund_stuck_minutes') BEGIN UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'commerce_revision'; END;

--> statement-breakpoint
DROP TRIGGER commerce_revision_settings_update;

--> statement-breakpoint
CREATE TRIGGER commerce_revision_settings_update AFTER UPDATE ON settings WHEN NEW.key IN ('currency','stripe_tax_enabled','stripe_tax_confirmed','checkout_email_cap','checkout_account_cap','checkout_ip_cap','cart_max_qty','cart_max_lines','order_max_units','checkout_session_minutes','refund_retry_cap','refund_stuck_minutes') AND NEW.value != OLD.value BEGIN UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'commerce_revision'; END;

--> statement-breakpoint
DROP TRIGGER catalog_work_settings_insert;

--> statement-breakpoint
CREATE TRIGGER catalog_work_settings_insert AFTER INSERT ON settings WHEN NEW.key IN ('store_name','announcement_text','seo_title_template','canonical_base_url','currency','checkout_email_cap','checkout_account_cap','checkout_ip_cap','cart_max_qty','cart_max_lines','order_max_units','checkout_session_minutes','refund_retry_cap','refund_stuck_minutes') BEGIN INSERT INTO catalog_work (id, entity_type, entity_id, target_revision, processed_revision, created_at, updated_at) VALUES ('settings:store', 'settings', 'store', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(entity_type, entity_id) DO UPDATE SET target_revision = target_revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'); END;

--> statement-breakpoint
DROP TRIGGER catalog_work_settings_update;

--> statement-breakpoint
CREATE TRIGGER catalog_work_settings_update AFTER UPDATE ON settings WHEN NEW.value IS NOT OLD.value AND NEW.key IN ('store_name','announcement_text','seo_title_template','canonical_base_url','currency','checkout_email_cap','checkout_account_cap','checkout_ip_cap','cart_max_qty','cart_max_lines','order_max_units','checkout_session_minutes','refund_retry_cap','refund_stuck_minutes') BEGIN INSERT INTO catalog_work (id, entity_type, entity_id, target_revision, processed_revision, created_at, updated_at) VALUES ('settings:store', 'settings', 'store', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(entity_type, entity_id) DO UPDATE SET target_revision = target_revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'); END;

--> statement-breakpoint
DROP TRIGGER catalog_work_settings_delete;

--> statement-breakpoint
CREATE TRIGGER catalog_work_settings_delete AFTER DELETE ON settings WHEN OLD.key IN ('store_name','announcement_text','seo_title_template','canonical_base_url','currency','checkout_email_cap','checkout_account_cap','checkout_ip_cap','cart_max_qty','cart_max_lines','order_max_units','checkout_session_minutes','refund_retry_cap','refund_stuck_minutes') BEGIN INSERT INTO catalog_work (id, entity_type, entity_id, target_revision, processed_revision, created_at, updated_at) VALUES ('settings:store', 'settings', 'store', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(entity_type, entity_id) DO UPDATE SET target_revision = target_revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'); END;

--> statement-breakpoint
CREATE TRIGGER catalog_work_revision_insert AFTER INSERT ON catalog_work BEGIN UPDATE catalog_publication_state SET work_revision=work_revision+1 WHERE id=1; END;

--> statement-breakpoint
CREATE TRIGGER catalog_work_revision_update AFTER UPDATE OF target_revision ON catalog_work WHEN NEW.target_revision!=OLD.target_revision BEGIN UPDATE catalog_publication_state SET work_revision=work_revision+1 WHERE id=1; END;

--> statement-breakpoint
CREATE TRIGGER catalog_reference_due_insert AFTER INSERT ON catalog_ref_state WHEN NEW.pending_payload IS NOT NULL BEGIN
 UPDATE catalog_ref_state SET expected_payload=NEW.pending_payload,verify_after=strftime('%Y-%m-%dT%H:%M:%fZ','now','+65 seconds') WHERE ref_key=NEW.ref_key;
 INSERT OR IGNORE INTO catalog_invalidations(id,scope,scope_id,ref_key,ref_seq,created_at)
 SELECT 'reference:'||NEW.ref_key||':'||NEW.committed_seq,CASE WHEN NEW.ref_key='layout' OR NEW.ref_key LIKE 'listing:@%' THEN 'layout' ELSE 'listing' END,CASE WHEN NEW.ref_key='layout' OR NEW.ref_key LIKE 'listing:@%' THEN 'layout' WHEN NEW.ref_key='listing:all' THEN 'all' ELSE COALESCE((SELECT slug FROM collections WHERE id=substr(NEW.ref_key,9)),substr(NEW.ref_key,9)) END,NEW.ref_key,NEW.committed_seq,strftime('%Y-%m-%dT%H:%M:%fZ','now'); END;

--> statement-breakpoint
CREATE TRIGGER catalog_reference_due_update AFTER UPDATE OF committed_seq,pending_payload ON catalog_ref_state WHEN NEW.pending_payload IS NOT NULL BEGIN
 UPDATE catalog_ref_state SET expected_payload=NEW.pending_payload,verify_after=strftime('%Y-%m-%dT%H:%M:%fZ','now','+65 seconds') WHERE ref_key=NEW.ref_key;
 INSERT OR IGNORE INTO catalog_invalidations(id,scope,scope_id,ref_key,ref_seq,created_at)
 SELECT 'reference:'||NEW.ref_key||':'||NEW.committed_seq,CASE WHEN NEW.ref_key='layout' OR NEW.ref_key LIKE 'listing:@%' THEN 'layout' ELSE 'listing' END,CASE WHEN NEW.ref_key='layout' OR NEW.ref_key LIKE 'listing:@%' THEN 'layout' WHEN NEW.ref_key='listing:all' THEN 'all' ELSE COALESCE((SELECT slug FROM collections WHERE id=substr(NEW.ref_key,9)),substr(NEW.ref_key,9)) END,NEW.ref_key,NEW.committed_seq,strftime('%Y-%m-%dT%H:%M:%fZ','now'); END;

--> statement-breakpoint
CREATE TRIGGER catalog_card_invalidation_insert AFTER INSERT ON catalog_cards BEGIN INSERT INTO catalog_invalidations(id,scope,scope_id,created_at) VALUES(lower(hex(randomblob(16))),'product',NEW.slug,strftime('%Y-%m-%dT%H:%M:%fZ','now'));  END;

--> statement-breakpoint
CREATE TRIGGER catalog_card_invalidation_update AFTER UPDATE OF slug,revision,doc_revision ON catalog_cards BEGIN INSERT INTO catalog_invalidations(id,scope,scope_id,created_at) VALUES(lower(hex(randomblob(16))),'product',NEW.slug,strftime('%Y-%m-%dT%H:%M:%fZ','now')); INSERT INTO catalog_invalidations(id,scope,scope_id,created_at) SELECT lower(hex(randomblob(16))),'product',OLD.slug,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE OLD.slug!=NEW.slug; END;

--> statement-breakpoint
UPDATE catalog_ref_state SET expected_payload=pending_payload WHERE pending_payload IS NOT NULL;

--> statement-breakpoint
INSERT INTO catalog_work(id,entity_type,entity_id,target_revision,processed_revision,created_at,updated_at) VALUES('settings:store','settings','store',1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(entity_type,entity_id) DO UPDATE SET target_revision=target_revision+1;

--> statement-breakpoint
CREATE TRIGGER catalog_invalidation_reference_guard AFTER INSERT ON catalog_invalidations WHEN NEW.ref_key IS NULL AND NEW.scope IN ('layout','listing') BEGIN UPDATE catalog_invalidations SET ref_key=(SELECT ref_key FROM catalog_ref_state WHERE ref_key=CASE WHEN NEW.scope='layout' THEN 'layout' ELSE 'listing:'||COALESCE((SELECT id FROM collections WHERE slug=NEW.scope_id),NEW.scope_id) END),ref_seq=(SELECT committed_seq FROM catalog_ref_state WHERE ref_key=CASE WHEN NEW.scope='layout' THEN 'layout' ELSE 'listing:'||COALESCE((SELECT id FROM collections WHERE slug=NEW.scope_id),NEW.scope_id) END) WHERE id=NEW.id; END;

--> statement-breakpoint
CREATE TRIGGER catalog_editorial_invalidation_insert AFTER INSERT ON catalog_documents WHEN NEW.kind='editorial-pointer' BEGIN INSERT INTO catalog_invalidations(id,scope,scope_id,created_at) SELECT lower(hex(randomblob(16))),'editorial',json_extract(payload_json,'$.slug'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM catalog_documents WHERE key=json_extract(NEW.payload_json,'$.key'); END;

--> statement-breakpoint
CREATE TRIGGER catalog_editorial_invalidation_update AFTER UPDATE OF revision,payload_json ON catalog_documents WHEN NEW.kind='editorial-pointer' BEGIN INSERT INTO catalog_invalidations(id,scope,scope_id,created_at) SELECT lower(hex(randomblob(16))),'editorial',json_extract(payload_json,'$.slug'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM catalog_documents WHERE key=json_extract(NEW.payload_json,'$.key'); END;

--> statement-breakpoint
CREATE TRIGGER catalog_editorial_invalidation_delete AFTER DELETE ON catalog_documents WHEN OLD.kind='editorial-pointer' BEGIN INSERT INTO catalog_invalidations(id,scope,scope_id,created_at) SELECT lower(hex(randomblob(16))),'editorial',json_extract(payload_json,'$.slug'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM catalog_documents WHERE key=json_extract(OLD.payload_json,'$.key'); END;

--> statement-breakpoint
CREATE UNIQUE INDEX `maintenance_active_task_unique` ON `maintenance_runs` (`task`) WHERE "maintenance_runs"."state" IN ('pending','running');

--> statement-breakpoint
CREATE INDEX `catalog_work_pending_idx` ON `catalog_work` (`next_attempt_at`,`updated_at`) WHERE "catalog_work"."processed_revision"<"catalog_work"."target_revision";

--> statement-breakpoint
CREATE INDEX `catalog_reference_delivery_idx` ON `catalog_ref_state` (`delivery_retry_at`,`committed_seq`) WHERE "catalog_ref_state"."pending_payload" IS NOT NULL OR "catalog_ref_state"."committed_seq">"catalog_ref_state"."delivered_seq";

--> statement-breakpoint
CREATE INDEX `orders_reminder_due_idx` ON `orders` (`id`) WHERE "orders"."status"='canceled' AND "orders"."payment_status"='unpaid' AND "orders"."reminder_consent"=1 AND "orders"."reminder_suppressed_at" IS NULL AND "orders"."abandoned_reminded_at" IS NULL;

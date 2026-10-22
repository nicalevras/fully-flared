-- 0000_initial.sql — consolidated baseline for the maintained web app.
-- Generated in Phase 0 of the architecture refactor from the final
-- effective schema of the historical 0000-0029 migration chain
-- (tables, indexes, triggers, FTS) plus the chain's seed rows.
-- Fresh databases apply this file only; see web/REMEDIATION.md.

-- Tables
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text,
	`is_default` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`line1` text NOT NULL,
	`line2` text,
	`city` text NOT NULL,
	`state` text,
	`postal_code` text NOT NULL,
	`country` text NOT NULL,
	`phone` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`details_json` text,
	`created_at` text NOT NULL
);
CREATE TABLE batch_guard (id text PRIMARY KEY, CHECK (0));
CREATE TABLE `cart_items` (
	`id` text PRIMARY KEY NOT NULL,
	`cart_id` text NOT NULL,
	`sku` text NOT NULL,
	`qty` integer NOT NULL,
	`unit_price_cents` integer NOT NULL,
	FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `carts` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`customer_email` text,
	`user_id` text,
	`discount_id` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE catalog_publication (id integer PRIMARY KEY NOT NULL, dirty_revision integer NOT NULL DEFAULT 0, published_revision integer NOT NULL DEFAULT 0, version text, building_version text, pointer_written_at text);
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'manual' NOT NULL,
	`rule_json` text,
	`seo_title` text,
	`seo_description` text,
	`created_at` text NOT NULL
);
CREATE TABLE `discount_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`discount_id` text NOT NULL,
	`order_id` text NOT NULL,
	`customer_email` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`discount_id`) REFERENCES `discounts`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `discounts` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`type` text NOT NULL,
	`value` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`min_purchase_cents` integer DEFAULT 0 NOT NULL,
	`max_discount_cents` integer,
	`starts_at` text,
	`expires_at` text,
	`usage_limit` integer,
	`usage_per_customer` integer DEFAULT 1 NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`stripe_coupon_id` text,
	`created_at` text NOT NULL
);
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`alt_text` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
, `deletion_pending` integer DEFAULT false NOT NULL);
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`sku` text NOT NULL,
	`title` text NOT NULL,
	`qty` integer NOT NULL,
	`unit_price_cents` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`status` text DEFAULT 'pending_payment' NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`customer_email` text NOT NULL,
	`user_id` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`subtotal_cents` integer NOT NULL,
	`discount_cents` integer DEFAULT 0 NOT NULL,
	`shipping_cents` integer DEFAULT 0 NOT NULL,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer NOT NULL,
	`discount_id` text,
	`shipping_name` text,
	`shipping_address_json` text,
	`tracking_number` text,
	`tracking_url` text,
	`shipped_at` text,
	`stripe_checkout_session_id` text,
	`stripe_payment_intent_id` text,
	`checkout_attempt_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL, `abandoned_reminded_at` text, `customer_ip` text, transition_id text, shipping_country text, shipping_rate_id text, restocked_at text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`sent_at` text
, `retry_after` text, `claimed_at` text);
CREATE TABLE `pages` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`content_html` text DEFAULT '' NOT NULL,
	`seo_title` text,
	`seo_description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE TABLE `post_tags` (
	`post_id` text NOT NULL,
	`tag_id` text NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`excerpt` text DEFAULT '' NOT NULL,
	`content_html` text DEFAULT '' NOT NULL,
	`content_json` text,
	`cover_media_id` text,
	`author_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`published_at` text,
	`seo_title` text,
	`seo_description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`cover_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE "product_collections" (
	`product_id` text NOT NULL,
	`collection_id` text NOT NULL,
	PRIMARY KEY(`collection_id`, `product_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `product_media` (
	`product_id` text NOT NULL,
	`media_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`seo_title` text,
	`seo_description` text,
	`canonical_url` text,
	`og_image_key` text,
	`tax_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE VIRTUAL TABLE `products_fts` USING fts5(
  `title`, `description`, `slug`,
  content='products', content_rowid='rowid'
);
CREATE TABLE rate_limit (
  id text PRIMARY KEY NOT NULL,
  key text NOT NULL,
  count integer NOT NULL,
  last_request integer NOT NULL
);
CREATE TABLE reconciliation_cursors(name text PRIMARY KEY NOT NULL,cursor text NOT NULL DEFAULT '',updated_at text NOT NULL);
CREATE TABLE `redirects` (
	`id` text PRIMARY KEY NOT NULL,
	`from_path` text NOT NULL,
	`to_path` text NOT NULL,
	`created_at` text NOT NULL
);
CREATE TABLE `refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`stripe_refund_id` text,
	`amount_cents` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL, request_id text, purpose text NOT NULL DEFAULT 'staff', return_id text, restock integer NOT NULL DEFAULT 0, settled_at text, `attempts` integer DEFAULT 0 NOT NULL, `retry_after` text, `recovery_reason` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE "reservations" (
	`id` text PRIMARY KEY NOT NULL,
	`cart_id` text,
	`order_id` text,
	`sku` text NOT NULL,
	`qty` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
CREATE TABLE `return_items` (
	`id` text PRIMARY KEY NOT NULL,
	`return_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`sku` text NOT NULL,
	`title` text NOT NULL,
	`qty` integer NOT NULL,
	`unit_price_cents` integer NOT NULL,
	FOREIGN KEY (`return_id`) REFERENCES `returns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `returns` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`user_id` text,
	`reason` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
CREATE TABLE `shipping_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`zone_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'flat' NOT NULL,
	`amount_cents` integer DEFAULT 0 NOT NULL,
	`free_over_cents` integer,
	`per_kg_cents` integer,
	FOREIGN KEY (`zone_id`) REFERENCES `shipping_zones`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `shipping_zones` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`countries_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL
);
CREATE TABLE staff_two_factor_sessions (
  session_token_hash text PRIMARY KEY NOT NULL,
  user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  verified_at text NOT NULL
);
CREATE TABLE `stock` (
	`sku` text PRIMARY KEY NOT NULL,
	`on_hand` integer DEFAULT 0 NOT NULL,
	`reserved` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`sku`) REFERENCES `variants`(`sku`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `stock_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`sku` text NOT NULL,
	`delta_on_hand` integer DEFAULT 0 NOT NULL,
	`delta_reserved` integer DEFAULT 0 NOT NULL,
	`reason` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`created_at` text NOT NULL
);
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL
);
CREATE TABLE `two_factor` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`user_id` text NOT NULL, `verified` integer DEFAULT true, `failed_verification_count` integer DEFAULT 0, `locked_until` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`role` text DEFAULT 'customer' NOT NULL,
	`banned` integer DEFAULT false NOT NULL,
	`ban_reason` text,
	`ban_expires` integer,
	`two_factor_enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE TABLE `variants` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`sku` text NOT NULL,
	`title` text NOT NULL,
	`price_cents` integer NOT NULL,
	`compare_at_cents` integer,
	`cost_cents` integer,
	`weight_grams` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`continue_selling` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
CREATE TABLE `webhook_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'stripe' NOT NULL,
	`event_id` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`received_at` text NOT NULL,
	`processed_at` text
, `retry_after` text);

-- Indexes
CREATE UNIQUE INDEX `cart_items_cart_sku_idx` ON `cart_items` (`cart_id`,`sku`);
CREATE UNIQUE INDEX `carts_token_hash_unique` ON `carts` (`token_hash`);
CREATE UNIQUE INDEX `collections_slug_unique` ON `collections` (`slug`);
CREATE INDEX discount_usage_customer_idx ON discount_usage(discount_id,customer_email);
CREATE UNIQUE INDEX `discount_usage_order_idx` ON `discount_usage` (`order_id`,`discount_id`);
CREATE UNIQUE INDEX `discounts_code_unique` ON `discounts` (`code`);
CREATE INDEX `ledger_sku_idx` ON `stock_ledger` (`sku`,`created_at`);
CREATE UNIQUE INDEX `media_r2_key_unique` ON `media` (`r2_key`);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE UNIQUE INDEX `orders_checkout_attempt_id_unique` ON `orders` (`checkout_attempt_id`);
CREATE INDEX `orders_created_id_idx` ON `orders` (`created_at`,`id`);
CREATE INDEX `orders_email_idx` ON `orders` (`customer_email`);
CREATE UNIQUE INDEX `orders_number_unique` ON `orders` (`number`);
CREATE INDEX orders_payment_intent_idx ON orders (stripe_payment_intent_id);
CREATE INDEX `orders_status_idx` ON `orders` (`status`,`created_at`);
CREATE UNIQUE INDEX `orders_stripe_checkout_session_id_unique` ON `orders` (`stripe_checkout_session_id`);
CREATE INDEX `outbox_status_idx` ON `outbox` (`status`,`created_at`);
CREATE UNIQUE INDEX `pages_slug_unique` ON `pages` (`slug`);
CREATE UNIQUE INDEX `posts_slug_unique` ON `posts` (`slug`);
CREATE INDEX `posts_status_idx` ON `posts` (`status`,`published_at`);
CREATE INDEX `product_collections_product_idx` ON `product_collections` (`product_id`);
CREATE INDEX product_media_media_idx ON product_media (media_id);
CREATE INDEX product_media_product_idx ON product_media (product_id);
CREATE INDEX `products_created_id_idx` ON `products` (`created_at`,`id`);
CREATE UNIQUE INDEX `products_slug_unique` ON `products` (`slug`);
CREATE INDEX `products_status_idx` ON `products` (`status`);
CREATE UNIQUE INDEX rate_limit_key_idx ON rate_limit (key);
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);
CREATE UNIQUE INDEX `redirects_from_path_unique` ON `redirects` (`from_path`);
CREATE INDEX refunds_order_idx ON refunds (order_id);
CREATE UNIQUE INDEX refunds_request_id_unique ON refunds(request_id);
CREATE INDEX reservations_order_idx ON reservations (order_id);
CREATE INDEX `reservations_status_idx` ON `reservations` (`status`,`expires_at`);
CREATE INDEX `return_items_return_idx` ON `return_items` (`return_id`);
CREATE UNIQUE INDEX `return_items_return_item_unique` ON `return_items` (`return_id`,`order_item_id`);
CREATE UNIQUE INDEX `returns_active_order_unique` ON `returns` (`order_id`) WHERE "returns"."status" IN ('requested','approved');
CREATE INDEX returns_order_idx ON returns (order_id);
CREATE INDEX `returns_status_created_id_idx` ON `returns` (`status`,`created_at`,`id`);
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);
CREATE INDEX session_user_idx ON session (user_id);
CREATE INDEX staff_two_factor_sessions_user_idx ON staff_two_factor_sessions (user_id);
CREATE UNIQUE INDEX `tags_slug_unique` ON `tags` (`slug`);
CREATE INDEX `user_created_id_idx` ON `user` (`created_at`,`id`);
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);
CREATE INDEX `variants_product_idx` ON `variants` (`product_id`);
CREATE UNIQUE INDEX `variants_sku_unique` ON `variants` (`sku`);
CREATE UNIQUE INDEX `webhook_inbox_event_id_unique` ON `webhook_inbox` (`event_id`);

-- Triggers
CREATE TRIGGER cart_items_limits_insert BEFORE INSERT ON cart_items
WHEN NEW.qty<1 OR (NEW.qty>COALESCE(CAST((SELECT value FROM settings WHERE key='cart_max_qty') AS INTEGER),99) AND NEW.qty>COALESCE((SELECT qty FROM cart_items WHERE cart_id=NEW.cart_id AND sku=NEW.sku),0))
 OR (NOT EXISTS(SELECT 1 FROM cart_items WHERE cart_id=NEW.cart_id AND sku=NEW.sku) AND (SELECT COUNT(*) FROM cart_items WHERE cart_id=NEW.cart_id)>=COALESCE(CAST((SELECT value FROM settings WHERE key='cart_max_lines') AS INTEGER),50))
BEGIN SELECT RAISE(ABORT,'cart line or quantity limit exceeded'); END;
CREATE TRIGGER cart_items_limits_update BEFORE UPDATE OF qty ON cart_items WHEN NEW.qty<1 OR (NEW.qty>OLD.qty AND NEW.qty>COALESCE(CAST((SELECT value FROM settings WHERE key='cart_max_qty') AS INTEGER),99))
BEGIN SELECT RAISE(ABORT,'cart quantity limit exceeded'); END;
CREATE TRIGGER catalog_dirty_collections_delete AFTER DELETE ON collections BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_collections_insert AFTER INSERT ON collections BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_collections_update AFTER UPDATE ON collections BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_media_delete AFTER DELETE ON media BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_media_insert AFTER INSERT ON media BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_media_update AFTER UPDATE ON media BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_pages_delete AFTER DELETE ON pages BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_pages_insert AFTER INSERT ON pages BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_pages_update AFTER UPDATE ON pages BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_posts_delete AFTER DELETE ON posts BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_posts_insert AFTER INSERT ON posts BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_posts_update AFTER UPDATE ON posts BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_product_collections_delete AFTER DELETE ON product_collections BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_product_collections_insert AFTER INSERT ON product_collections BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_product_collections_update AFTER UPDATE ON product_collections BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_product_media_delete AFTER DELETE ON product_media BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_product_media_insert AFTER INSERT ON product_media BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_product_media_update AFTER UPDATE ON product_media BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_products_delete AFTER DELETE ON products BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_products_insert AFTER INSERT ON products BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_products_update AFTER UPDATE ON products BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_redirects_delete AFTER DELETE ON redirects BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_redirects_insert AFTER INSERT ON redirects BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_redirects_update AFTER UPDATE ON redirects BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_settings_delete AFTER DELETE ON settings WHEN OLD.key IN ('store_name','announcement_text','seo_title_template','canonical_base_url','currency','checkout_email_cap','checkout_account_cap','checkout_ip_cap','cart_max_qty','cart_max_lines','order_max_units','checkout_hold_minutes','refund_retry_cap','refund_stuck_minutes') BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_settings_insert AFTER INSERT ON settings WHEN NEW.key IN ('store_name','announcement_text','seo_title_template','canonical_base_url','currency','checkout_email_cap','checkout_account_cap','checkout_ip_cap','cart_max_qty','cart_max_lines','order_max_units','checkout_hold_minutes','refund_retry_cap','refund_stuck_minutes') BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_settings_update AFTER UPDATE ON settings WHEN (NEW.key IN ('store_name','announcement_text','seo_title_template','canonical_base_url','currency','checkout_email_cap','checkout_account_cap','checkout_ip_cap','cart_max_qty','cart_max_lines','order_max_units','checkout_hold_minutes','refund_retry_cap','refund_stuck_minutes') OR OLD.key IN ('store_name','announcement_text','seo_title_template','canonical_base_url','currency','checkout_email_cap','checkout_account_cap','checkout_ip_cap','cart_max_qty','cart_max_lines','order_max_units','checkout_hold_minutes','refund_retry_cap','refund_stuck_minutes')) AND (NEW.key IS NOT OLD.key OR NEW.value IS NOT OLD.value) BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_variants_delete AFTER DELETE ON variants BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_variants_insert AFTER INSERT ON variants BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER catalog_dirty_variants_update AFTER UPDATE ON variants BEGIN UPDATE catalog_publication SET dirty_revision=dirty_revision+1 WHERE id=1; END;
CREATE TRIGGER checkout_currency_insert BEFORE INSERT ON orders
WHEN NEW.status='pending_payment' AND NEW.currency != COALESCE((SELECT value FROM settings WHERE key='currency'),'USD')
BEGIN SELECT RAISE(ABORT,'checkout currency changed; request a new quote'); END;
CREATE TRIGGER checkout_hold_cap BEFORE INSERT ON orders WHEN NEW.status='pending_payment' AND (
 (SELECT COUNT(*) FROM orders WHERE customer_email=NEW.customer_email AND status='pending_payment' AND created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'))>=COALESCE(CAST((SELECT value FROM settings WHERE key='checkout_email_cap') AS INTEGER),5)
 OR (NEW.user_id IS NOT NULL AND (SELECT COUNT(*) FROM orders WHERE user_id=NEW.user_id AND status='pending_payment' AND created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'))>=COALESCE(CAST((SELECT value FROM settings WHERE key='checkout_account_cap') AS INTEGER),5))
 OR (NEW.customer_ip IS NOT NULL AND (SELECT COUNT(*) FROM orders WHERE customer_ip=NEW.customer_ip AND status='pending_payment' AND created_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'))>=COALESCE(CAST((SELECT value FROM settings WHERE key='checkout_ip_cap') AS INTEGER),10)))
BEGIN SELECT RAISE(ABORT,'Too many open checkouts'); END;
CREATE TRIGGER currency_lock_delete BEFORE DELETE ON settings
WHEN OLD.key='currency_locked' AND OLD.value='1'
BEGIN SELECT RAISE(ABORT,'paid order currency lock is permanent'); END;
CREATE TRIGGER currency_lock_insert BEFORE INSERT ON settings
WHEN NEW.key='currency_locked' AND NEW.value!='1' AND EXISTS(SELECT 1 FROM settings WHERE key='currency_locked' AND value='1')
BEGIN SELECT RAISE(ABORT,'paid order currency lock is permanent'); END;
CREATE TRIGGER currency_lock_update BEFORE UPDATE OF key,value ON settings
WHEN OLD.key='currency_locked' AND OLD.value='1' AND (NEW.key!='currency_locked' OR NEW.value!='1')
BEGIN SELECT RAISE(ABORT,'paid order currency lock is permanent'); END;
CREATE TRIGGER currency_setting_delete BEFORE DELETE ON settings
WHEN OLD.key='currency' AND OLD.value!='USD'
 AND (EXISTS(SELECT 1 FROM orders WHERE status='pending_payment') OR EXISTS(SELECT 1 FROM settings WHERE key='currency_locked' AND value='1'))
BEGIN SELECT RAISE(ABORT,'currency is locked by a pending or paid order'); END;
CREATE TRIGGER currency_setting_insert BEFORE INSERT ON settings
WHEN NEW.key='currency' AND NEW.value != COALESCE((SELECT value FROM settings WHERE key='currency'),'USD')
 AND (EXISTS(SELECT 1 FROM orders WHERE status='pending_payment') OR EXISTS(SELECT 1 FROM settings WHERE key='currency_locked' AND value='1'))
BEGIN SELECT RAISE(ABORT,'currency is locked by a pending or paid order'); END;
CREATE TRIGGER currency_setting_update BEFORE UPDATE OF key,value ON settings
WHEN OLD.key='currency' AND (NEW.key!='currency' OR NEW.value!=OLD.value)
 AND (EXISTS(SELECT 1 FROM orders WHERE status='pending_payment') OR EXISTS(SELECT 1 FROM settings WHERE key='currency_locked' AND value='1'))
BEGIN SELECT RAISE(ABORT,'currency is locked by a pending or paid order'); END;
CREATE TRIGGER discount_customer_cap_insert BEFORE INSERT ON discount_usage
WHEN (SELECT COUNT(*) FROM discount_usage WHERE discount_id=NEW.discount_id AND lower(customer_email)=lower(NEW.customer_email)) >= (SELECT usage_per_customer FROM discounts WHERE id=NEW.discount_id)
BEGIN SELECT RAISE(ABORT,'discount_usage customer limit reached'); END;
CREATE TRIGGER discount_customer_cap_update BEFORE UPDATE OF discount_id,customer_email ON discount_usage
WHEN (SELECT COUNT(*) FROM discount_usage WHERE id!=OLD.id AND discount_id=NEW.discount_id AND lower(customer_email)=lower(NEW.customer_email)) >= (SELECT usage_per_customer FROM discounts WHERE id=NEW.discount_id)
BEGIN SELECT RAISE(ABORT,'discount_usage customer limit reached'); END;
CREATE TRIGGER discount_percentage_insert BEFORE INSERT ON discounts
WHEN NEW.type='percentage' AND (NEW.value<0 OR NEW.value>100)
BEGIN SELECT RAISE(ABORT,'percentage discount must be between 0 and 100'); END;
CREATE TRIGGER discount_percentage_update BEFORE UPDATE OF type,value ON discounts
WHEN NEW.type='percentage' AND (NEW.value<0 OR NEW.value>100)
BEGIN SELECT RAISE(ABORT,'percentage discount must be between 0 and 100'); END;
CREATE TRIGGER ledger_reason_guard_insert BEFORE INSERT ON stock_ledger
WHEN NEW.reason NOT IN ('reserve','release','sale','restock','correction','damaged','return')
BEGIN SELECT RAISE(ABORT, 'invalid ledger reason'); END;
CREATE TRIGGER media_pending_claim BEFORE UPDATE OF deletion_pending ON media
WHEN NEW.deletion_pending=1 AND (EXISTS(SELECT 1 FROM product_media WHERE media_id=NEW.id) OR EXISTS(SELECT 1 FROM posts WHERE cover_media_id=NEW.id))
BEGIN SELECT RAISE(ABORT,'image is still in use'); END;
CREATE TRIGGER media_pending_permanent BEFORE UPDATE OF deletion_pending ON media
WHEN OLD.deletion_pending=1 AND NEW.deletion_pending!=1
BEGIN SELECT RAISE(ABORT,'image deletion must be completed'); END;
CREATE TRIGGER media_pending_post_insert BEFORE INSERT ON posts
WHEN EXISTS(SELECT 1 FROM media WHERE id=NEW.cover_media_id AND deletion_pending=1)
BEGIN SELECT RAISE(ABORT,'image deletion is pending'); END;
CREATE TRIGGER media_pending_post_update BEFORE UPDATE OF cover_media_id ON posts
WHEN EXISTS(SELECT 1 FROM media WHERE id=NEW.cover_media_id AND deletion_pending=1)
BEGIN SELECT RAISE(ABORT,'image deletion is pending'); END;
CREATE TRIGGER media_pending_product_insert BEFORE INSERT ON product_media
WHEN EXISTS(SELECT 1 FROM media WHERE id=NEW.media_id AND deletion_pending=1)
BEGIN SELECT RAISE(ABORT,'image deletion is pending'); END;
CREATE TRIGGER media_pending_product_update BEFORE UPDATE OF media_id ON product_media
WHEN EXISTS(SELECT 1 FROM media WHERE id=NEW.media_id AND deletion_pending=1)
BEGIN SELECT RAISE(ABORT,'image deletion is pending'); END;
CREATE TRIGGER open_return_blocks_general_refund BEFORE INSERT ON refunds
WHEN NEW.return_id IS NULL AND NEW.purpose='staff' AND EXISTS(SELECT 1 FROM returns WHERE order_id=NEW.order_id AND status IN ('requested','approved','refund_failed'))
BEGIN SELECT RAISE(ABORT,'order has an open return; refund must go through the return'); END;
CREATE TRIGGER order_items_limits_insert BEFORE INSERT ON order_items
WHEN NEW.qty>COALESCE(CAST((SELECT value FROM settings WHERE key='cart_max_qty') AS INTEGER),99) OR (SELECT COUNT(*) FROM order_items WHERE order_id=NEW.order_id)>=COALESCE(CAST((SELECT value FROM settings WHERE key='cart_max_lines') AS INTEGER),50)
 OR NEW.qty+COALESCE((SELECT SUM(qty) FROM order_items WHERE order_id=NEW.order_id),0)>COALESCE(CAST((SELECT value FROM settings WHERE key='order_max_units') AS INTEGER),500)
BEGIN SELECT RAISE(ABORT,'order line or quantity limit exceeded'); END;
CREATE TRIGGER order_items_qty_guard_insert
BEFORE INSERT ON order_items
WHEN NEW.qty <= 0 OR NEW.unit_price_cents < 0
BEGIN
  SELECT RAISE(ABORT, 'order item qty must be positive and price non-negative');
END;
CREATE TRIGGER order_payment_currency_guard BEFORE UPDATE OF status ON orders
WHEN OLD.status IN ('pending_payment','canceled') AND NEW.status='paid' AND NEW.currency!=COALESCE((SELECT value FROM settings WHERE key='currency'),'USD')
BEGIN SELECT RAISE(ABORT,'payment recovery currency differs from store currency'); END;
CREATE TRIGGER orders_status_guard_insert BEFORE INSERT ON orders
WHEN NEW.status NOT IN ('pending_payment','paid','processing','shipped','delivered','refunded','partially_refunded','canceled')
  OR NEW.payment_status NOT IN ('unpaid','paid','failed','refunded','partially_refunded','disputed')
BEGIN SELECT RAISE(ABORT, 'invalid order status'); END;
CREATE TRIGGER orders_status_guard_update BEFORE UPDATE ON orders
WHEN NEW.status NOT IN ('pending_payment','paid','processing','shipped','delivered','refunded','partially_refunded','canceled')
  OR NEW.payment_status NOT IN ('unpaid','paid','failed','refunded','partially_refunded','disputed')
BEGIN SELECT RAISE(ABORT, 'invalid order status'); END;
CREATE TRIGGER outbox_status_guard_insert BEFORE INSERT ON outbox
WHEN NEW.status NOT IN ('pending','sending','sent','failed')
BEGIN SELECT RAISE(ABORT, 'invalid outbox status'); END;
CREATE TRIGGER outbox_status_guard_update BEFORE UPDATE ON outbox
WHEN NEW.status NOT IN ('pending','sending','sent','failed')
BEGIN SELECT RAISE(ABORT, 'invalid outbox status'); END;
CREATE TRIGGER posts_status_guard_insert BEFORE INSERT ON posts
WHEN NEW.status NOT IN ('draft','published','scheduled')
BEGIN SELECT RAISE(ABORT, 'invalid post status'); END;
CREATE TRIGGER posts_status_guard_update BEFORE UPDATE ON posts
WHEN NEW.status NOT IN ('draft','published','scheduled')
BEGIN SELECT RAISE(ABORT, 'invalid post status'); END;
CREATE TRIGGER `products_fts_ad` AFTER DELETE ON `products` BEGIN
  INSERT INTO `products_fts` (`products_fts`, rowid, title, description, slug) VALUES ('delete', old.rowid, old.title, old.description, old.slug);
END;
CREATE TRIGGER `products_fts_ai` AFTER INSERT ON `products` BEGIN
  INSERT INTO `products_fts` (rowid, title, description, slug) VALUES (new.rowid, new.title, new.description, new.slug);
END;
CREATE TRIGGER `products_fts_au` AFTER UPDATE ON `products` BEGIN
  INSERT INTO `products_fts` (`products_fts`, rowid, title, description, slug) VALUES ('delete', old.rowid, old.title, old.description, old.slug);
  INSERT INTO `products_fts` (rowid, title, description, slug) VALUES (new.rowid, new.title, new.description, new.slug);
END;
CREATE TRIGGER products_status_guard_insert BEFORE INSERT ON products
WHEN NEW.status NOT IN ('active','draft','archived')
BEGIN SELECT RAISE(ABORT, 'invalid product status'); END;
CREATE TRIGGER products_status_guard_update BEFORE UPDATE ON products
WHEN NEW.status NOT IN ('active','draft','archived')
BEGIN SELECT RAISE(ABORT, 'invalid product status'); END;
CREATE TRIGGER refund_recovery_reason_insert BEFORE INSERT ON refunds
WHEN NEW.recovery_reason IS NOT NULL AND (NEW.purpose!='late_payment' OR NEW.recovery_reason NOT IN ('capacity_unavailable','currency_changed'))
BEGIN SELECT RAISE(ABORT,'invalid refund recovery reason'); END;
CREATE TRIGGER refund_recovery_reason_update BEFORE UPDATE OF recovery_reason,purpose ON refunds
WHEN NEW.recovery_reason IS NOT OLD.recovery_reason OR (NEW.recovery_reason IS NOT NULL AND (NEW.purpose!='late_payment' OR NEW.recovery_reason NOT IN ('capacity_unavailable','currency_changed')))
BEGIN SELECT RAISE(ABORT,'refund recovery reason is immutable'); END;
CREATE TRIGGER refunds_attempt_limit BEFORE UPDATE OF attempts ON refunds
WHEN NEW.attempts>OLD.attempts AND NEW.attempts>COALESCE(CAST((SELECT value FROM settings WHERE key='refund_retry_cap') AS INTEGER),5)
BEGIN SELECT RAISE(ABORT,'refund retry limit exceeded'); END;
CREATE TRIGGER refunds_balance_guard BEFORE INSERT ON refunds
WHEN NEW.amount_cents <= 0 OR NEW.amount_cents + COALESCE((SELECT SUM(amount_cents) FROM refunds WHERE order_id = NEW.order_id AND status NOT IN ('failed','canceled')),0) > (SELECT total_cents FROM orders WHERE id = NEW.order_id)
BEGIN SELECT RAISE(ABORT, 'refund exceeds remaining balance'); END;
CREATE TRIGGER refunds_status_guard_insert BEFORE INSERT ON refunds
WHEN NEW.status NOT IN ('pending','requires_action','uncertain','succeeded','failed','canceled')
 OR NEW.purpose NOT IN ('staff','return','late_payment','external')
BEGIN SELECT RAISE(ABORT, 'invalid refund state'); END;
CREATE TRIGGER refunds_status_guard_update BEFORE UPDATE ON refunds
WHEN NEW.status NOT IN ('pending','requires_action','uncertain','succeeded','failed','canceled')
 OR NEW.purpose NOT IN ('staff','return','late_payment','external')
BEGIN SELECT RAISE(ABORT, 'invalid refund state'); END;
CREATE TRIGGER reservations_qty_guard_insert
BEFORE INSERT ON reservations
WHEN NEW.qty <= 0
BEGIN
  SELECT RAISE(ABORT, 'reservation qty must be positive');
END;
CREATE TRIGGER reservations_status_guard_insert BEFORE INSERT ON reservations
WHEN NEW.status NOT IN ('active','committed','released','expired')
BEGIN SELECT RAISE(ABORT, 'invalid reservation status'); END;
CREATE TRIGGER reservations_status_guard_update BEFORE UPDATE ON reservations
WHEN NEW.status NOT IN ('active','committed','released','expired')
BEGIN SELECT RAISE(ABORT, 'invalid reservation status'); END;
CREATE TRIGGER return_decision_update BEFORE UPDATE OF status ON returns
WHEN OLD.status='requested' AND NEW.status IN ('approved','rejected') AND EXISTS(SELECT 1 FROM refunds WHERE return_id=OLD.id AND status NOT IN ('failed','canceled'))
BEGIN SELECT RAISE(ABORT,'return refund is active or successful'); END;
CREATE TRIGGER return_items_quantity_guard BEFORE INSERT ON return_items
WHEN (SELECT COALESCE(SUM(ri.qty),0) FROM return_items ri JOIN returns r ON r.id=ri.return_id WHERE ri.order_item_id=NEW.order_item_id AND r.status!='rejected') + NEW.qty > (SELECT qty FROM order_items WHERE id=NEW.order_item_id)
BEGIN SELECT RAISE(ABORT,'return quantity exceeds purchased quantity'); END;
CREATE TRIGGER return_refund_insert BEFORE INSERT ON refunds
WHEN (NEW.return_id IS NOT NULL OR NEW.purpose='return') AND NOT EXISTS(SELECT 1 FROM returns WHERE id=NEW.return_id AND order_id=NEW.order_id AND status IN ('requested','approved','refund_failed'))
BEGIN SELECT RAISE(ABORT,'return already decided; refund cannot be created'); END;
CREATE TRIGGER return_reject_live_refund_guard BEFORE UPDATE OF status ON returns
WHEN OLD.status='refund_failed' AND NEW.status='rejected' AND EXISTS(SELECT 1 FROM refunds WHERE return_id=OLD.id AND status NOT IN ('failed','canceled'))
BEGIN SELECT RAISE(ABORT,'return refund is active or successful'); END;
CREATE TRIGGER returns_status_guard_insert BEFORE INSERT ON returns
WHEN NEW.status NOT IN ('requested','approved','rejected','refunded','refund_failed')
BEGIN SELECT RAISE(ABORT, 'invalid return status'); END;
CREATE TRIGGER returns_status_guard_update BEFORE UPDATE ON returns
WHEN NEW.status NOT IN ('requested','approved','rejected','refunded','refund_failed')
BEGIN SELECT RAISE(ABORT, 'invalid return status'); END;
CREATE TRIGGER settings_limit_guard_insert BEFORE INSERT ON settings
WHEN NEW.key IN ('checkout_email_cap','checkout_account_cap','checkout_ip_cap','cart_max_qty','cart_max_lines','order_max_units','checkout_hold_minutes','refund_retry_cap','refund_stuck_minutes') AND (NEW.value='' OR NEW.value GLOB '*[^0-9]*' OR CAST(CAST(NEW.value AS INTEGER) AS TEXT)!=NEW.value OR CAST(NEW.value AS INTEGER)<CASE NEW.key WHEN 'checkout_email_cap' THEN 1 WHEN 'checkout_account_cap' THEN 1 WHEN 'checkout_ip_cap' THEN 1 WHEN 'cart_max_qty' THEN 1 WHEN 'cart_max_lines' THEN 1 WHEN 'order_max_units' THEN 1 WHEN 'checkout_hold_minutes' THEN 42 WHEN 'refund_retry_cap' THEN 1 WHEN 'refund_stuck_minutes' THEN 1 END OR CAST(NEW.value AS INTEGER)>CASE NEW.key WHEN 'checkout_email_cap' THEN 100 WHEN 'checkout_account_cap' THEN 100 WHEN 'checkout_ip_cap' THEN 1000 WHEN 'cart_max_qty' THEN 999 WHEN 'cart_max_lines' THEN 100 WHEN 'order_max_units' THEN 10000 WHEN 'checkout_hold_minutes' THEN 1450 WHEN 'refund_retry_cap' THEN 20 WHEN 'refund_stuck_minutes' THEN 10080 END)
BEGIN SELECT RAISE(ABORT,'invalid store limit setting'); END;
CREATE TRIGGER settings_limit_guard_update BEFORE UPDATE OF key,value ON settings
WHEN NEW.key IN ('checkout_email_cap','checkout_account_cap','checkout_ip_cap','cart_max_qty','cart_max_lines','order_max_units','checkout_hold_minutes','refund_retry_cap','refund_stuck_minutes') AND (NEW.value='' OR NEW.value GLOB '*[^0-9]*' OR CAST(CAST(NEW.value AS INTEGER) AS TEXT)!=NEW.value OR CAST(NEW.value AS INTEGER)<CASE NEW.key WHEN 'checkout_email_cap' THEN 1 WHEN 'checkout_account_cap' THEN 1 WHEN 'checkout_ip_cap' THEN 1 WHEN 'cart_max_qty' THEN 1 WHEN 'cart_max_lines' THEN 1 WHEN 'order_max_units' THEN 1 WHEN 'checkout_hold_minutes' THEN 42 WHEN 'refund_retry_cap' THEN 1 WHEN 'refund_stuck_minutes' THEN 1 END OR CAST(NEW.value AS INTEGER)>CASE NEW.key WHEN 'checkout_email_cap' THEN 100 WHEN 'checkout_account_cap' THEN 100 WHEN 'checkout_ip_cap' THEN 1000 WHEN 'cart_max_qty' THEN 999 WHEN 'cart_max_lines' THEN 100 WHEN 'order_max_units' THEN 10000 WHEN 'checkout_hold_minutes' THEN 1450 WHEN 'refund_retry_cap' THEN 20 WHEN 'refund_stuck_minutes' THEN 10080 END)
BEGIN SELECT RAISE(ABORT,'invalid store limit setting'); END;
CREATE TRIGGER stock_guard_insert
BEFORE INSERT ON stock
WHEN NEW.on_hand < 0 OR NEW.reserved < 0
BEGIN
  SELECT RAISE(ABORT, 'stock counters cannot be negative');
END;
CREATE TRIGGER stock_guard_update
BEFORE UPDATE ON stock
WHEN NEW.reserved < 0
  OR (NEW.on_hand < 0 AND COALESCE((SELECT continue_selling FROM variants WHERE variants.sku = NEW.sku), 0) = 0)
BEGIN
  SELECT RAISE(ABORT, 'stock counters would go negative');
END;
CREATE TRIGGER stock_ledger_append_delete BEFORE DELETE ON stock_ledger
BEGIN SELECT RAISE(ABORT, 'inventory ledger is append-only'); END;
CREATE TRIGGER stock_ledger_append_update BEFORE UPDATE ON stock_ledger
BEGIN SELECT RAISE(ABORT, 'inventory ledger is append-only'); END;
CREATE TRIGGER stock_reserved_guard_insert
BEFORE INSERT ON stock
WHEN NEW.reserved > NEW.on_hand
  AND COALESCE((SELECT continue_selling FROM variants WHERE variants.sku = NEW.sku), 0) = 0
BEGIN
  SELECT RAISE(ABORT, 'reserved cannot exceed on_hand');
END;
CREATE TRIGGER stock_reserved_guard_update BEFORE UPDATE ON stock
WHEN NEW.reserved > NEW.on_hand AND (NEW.reserved > OLD.reserved OR NEW.on_hand < OLD.on_hand)
 AND COALESCE((SELECT continue_selling FROM variants WHERE sku = NEW.sku),0) = 0
BEGIN SELECT RAISE(ABORT, 'reserved cannot exceed on_hand'); END;
CREATE TRIGGER user_last_owner_delete BEFORE DELETE ON user
WHEN OLD.role IN ('owner','admin') AND OLD.banned=0
 AND NOT EXISTS(SELECT 1 FROM user WHERE id!=OLD.id AND role IN ('owner','admin') AND banned=0)
BEGIN SELECT RAISE(ABORT,'the last unbanned owner/admin cannot be deleted'); END;
CREATE TRIGGER user_last_owner_update BEFORE UPDATE OF role,banned ON user
WHEN OLD.role IN ('owner','admin') AND OLD.banned=0
 AND (NEW.role NOT IN ('owner','admin') OR NEW.banned!=0)
 AND NOT EXISTS(SELECT 1 FROM user WHERE id!=OLD.id AND role IN ('owner','admin') AND banned=0)
BEGIN SELECT RAISE(ABORT,'the last unbanned owner/admin cannot be demoted or banned'); END;
CREATE TRIGGER user_protected_delete BEFORE DELETE ON user
WHEN OLD.role IN ('owner','admin')
BEGIN SELECT RAISE(ABORT,'protected owner/admin must be demoted before deletion'); END;
CREATE TRIGGER variants_backorder_guard BEFORE UPDATE OF continue_selling ON variants
WHEN NEW.continue_selling = 0 AND OLD.continue_selling = 1
 AND EXISTS (SELECT 1 FROM stock WHERE sku = NEW.sku AND (reserved > on_hand OR on_hand < 0))
BEGIN SELECT RAISE(ABORT, 'cannot disable backorders while stock or holds exceed availability'); END;
CREATE TRIGGER variants_price_guard_insert
BEFORE INSERT ON variants
WHEN NEW.price_cents < 0
BEGIN
  SELECT RAISE(ABORT, 'variant price cannot be negative');
END;
CREATE TRIGGER variants_price_guard_update
BEFORE UPDATE ON variants
WHEN NEW.price_cents < 0
BEGIN
  SELECT RAISE(ABORT, 'variant price cannot be negative');
END;
CREATE TRIGGER variants_status_guard_insert BEFORE INSERT ON variants
WHEN NEW.status NOT IN ('active','draft')
BEGIN SELECT RAISE(ABORT, 'invalid variant status'); END;
CREATE TRIGGER variants_status_guard_update BEFORE UPDATE ON variants
WHEN NEW.status NOT IN ('active','draft')
BEGIN SELECT RAISE(ABORT, 'invalid variant status'); END;

-- Seed rows (from historical 0017 and 0014)
INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES
('checkout_email_cap','5',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('checkout_account_cap','5',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('checkout_ip_cap','10',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('cart_max_qty','99',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('cart_max_lines','50',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('order_max_units','500',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('checkout_hold_minutes','42',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('refund_retry_cap','5',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('refund_stuck_minutes','60',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO catalog_publication (id, dirty_revision) VALUES (1, 1);

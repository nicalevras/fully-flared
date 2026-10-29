CREATE INDEX `posts_created_id_idx` ON `posts` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `media_created_id_idx` ON `media` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `discounts_created_id_idx` ON `discounts` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `orders_payment_currency_idx` ON `orders` (`payment_status`,`currency`,`total_cents`);--> statement-breakpoint
DROP TRIGGER IF EXISTS `products_fts_au`;--> statement-breakpoint
CREATE TRIGGER `products_fts_au` AFTER UPDATE ON `products` WHEN old.title IS NOT new.title OR old.description_text IS NOT new.description_text OR old.slug IS NOT new.slug BEGIN DELETE FROM products_fts WHERE rowid = old.rowid; INSERT INTO products_fts(rowid, title, description, slug) VALUES (new.rowid, new.title, new.description_text, new.slug); END;

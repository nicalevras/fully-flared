CREATE INDEX `products_title_id_idx` ON `products` (`title` COLLATE NOCASE,`id`);--> statement-breakpoint
CREATE INDEX `products_updated_id_idx` ON `products` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `products_status_created_id_idx` ON `products` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `products_status_updated_id_idx` ON `products` (`status`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `products_status_title_id_idx` ON `products` (`status`,`title` COLLATE NOCASE,`id`);
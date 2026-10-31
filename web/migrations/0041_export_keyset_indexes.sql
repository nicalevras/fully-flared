CREATE INDEX `orders_export_owner_idx` ON `orders` (`user_id`);--> statement-breakpoint
CREATE INDEX `orders_export_guest_idx` ON `orders` (lower("customer_email")) WHERE "orders"."user_id" IS NULL;
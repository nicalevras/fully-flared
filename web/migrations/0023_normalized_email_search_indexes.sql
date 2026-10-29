CREATE INDEX `orders_email_lower_idx` ON `orders` (lower(`customer_email`));--> statement-breakpoint
CREATE INDEX `user_email_lower_idx` ON `user` (lower(`email`));

CREATE INDEX `refunds_return_status_idx` ON `refunds` (`return_id`,`status`);--> statement-breakpoint
CREATE INDEX `refunds_stripe_refund_idx` ON `refunds` (`stripe_refund_id`);

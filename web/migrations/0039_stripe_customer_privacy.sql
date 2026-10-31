CREATE TABLE `order_stripe_customers` (
	`order_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`order_id`, `customer_id`),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_stripe_customers_customer_idx` ON `order_stripe_customers` (`customer_id`,`order_id`);--> statement-breakpoint
CREATE TABLE `stripe_customer_operations` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`created_at` text NOT NULL,
	`creation_deadline_at` text NOT NULL,
	`next_reconcile_at` text NOT NULL,
	`reconcile_cursor` text,
	`observed_at` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stripe_customer_operations_due_idx` ON `stripe_customer_operations` (`observed_at`,`next_reconcile_at`,`attempt_id`);--> statement-breakpoint
ALTER TABLE `orders` ADD `privacy_deleted_at` text;
--> statement-breakpoint
UPDATE orders SET privacy_deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE user_id IS NULL AND customer_email='deleted@invalid';
--> statement-breakpoint
INSERT INTO order_stripe_customers(order_id,customer_id,attempt_id,created_at)
SELECT order_id,stripe_customer_id,id,created_at FROM checkout_intents WHERE stripe_customer_id IS NOT NULL
ON CONFLICT(order_id,customer_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO stripe_customer_operations(attempt_id,order_id,created_at,creation_deadline_at,next_reconcile_at,observed_at)
SELECT id,order_id,COALESCE(first_provider_attempt_at,created_at),strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+23 hours'),created_at,
 CASE WHEN stripe_customer_id IS NOT NULL THEN updated_at END
FROM checkout_intents WHERE stripe_customer_id IS NOT NULL OR provider_step='customer';
--> statement-breakpoint
INSERT INTO outbox(id,type,payload_json,created_at)
SELECT DISTINCT 'stripe-customer-delete-'||c.customer_id,'stripe.customer.delete',json_object('customerId',c.customer_id),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM order_stripe_customers c JOIN orders o ON o.id=c.order_id
WHERE o.privacy_deleted_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM order_stripe_customers retained JOIN orders kept ON kept.id=retained.order_id
  WHERE retained.customer_id=c.customer_id AND kept.privacy_deleted_at IS NULL)
ON CONFLICT(id) DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER checkout_customer_association_insert AFTER INSERT ON checkout_intents
WHEN NEW.stripe_customer_id IS NOT NULL
BEGIN
 INSERT INTO order_stripe_customers(order_id,customer_id,attempt_id,created_at)
 VALUES(NEW.order_id,NEW.stripe_customer_id,NEW.id,NEW.created_at)
 ON CONFLICT(order_id,customer_id) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER checkout_customer_association_update AFTER UPDATE OF stripe_customer_id ON checkout_intents
WHEN NEW.stripe_customer_id IS NOT NULL
BEGIN
 INSERT INTO order_stripe_customers(order_id,customer_id,attempt_id,created_at)
 VALUES(NEW.order_id,NEW.stripe_customer_id,NEW.id,NEW.updated_at)
 ON CONFLICT(order_id,customer_id) DO NOTHING;
END;

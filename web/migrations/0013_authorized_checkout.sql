ALTER TABLE `carts` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `carts` ADD `active_checkout_id` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `stripe_customer_id` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `payment_intent_id` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `shipping_address_json` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `cart_id` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `cart_revision` integer;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `quote_json` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `quote_hash` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `quote_confirmed_at` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `superseded_by` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `allocation_id` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `payment_state` text DEFAULT 'awaiting_authorization' NOT NULL;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `payment_claim_token` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `payment_claim_expires_at` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `payment_fencing` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `payment_next_at` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `payment_attempted_at` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `authorized_at` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `authorization_deadline_at` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `captured_at` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `cancellation_attempted_at` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `cancel_requested` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `checkout_intents_payment_due_idx` ON `checkout_intents` (`payment_next_at`);--> statement-breakpoint
CREATE INDEX `checkout_intents_payment_intent_idx` ON `checkout_intents` (`payment_intent_id`);--> statement-breakpoint
CREATE INDEX `checkout_intents_cart_idx` ON `checkout_intents` (`cart_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER cart_revision_insert AFTER INSERT ON cart_items BEGIN UPDATE carts SET revision=revision+1 WHERE id=NEW.cart_id; END;
--> statement-breakpoint
CREATE TRIGGER cart_revision_update AFTER UPDATE ON cart_items WHEN NEW.qty IS NOT OLD.qty OR NEW.sku IS NOT OLD.sku OR NEW.unit_price_cents IS NOT OLD.unit_price_cents BEGIN UPDATE carts SET revision=revision+1 WHERE id=NEW.cart_id; END;
--> statement-breakpoint
CREATE TRIGGER cart_revision_delete AFTER DELETE ON cart_items BEGIN UPDATE carts SET revision=revision+1 WHERE id=OLD.cart_id; END;
--> statement-breakpoint
INSERT INTO settings(key,value,updated_at) VALUES('checkout_session_minutes',CAST(MAX(32,MIN(1440,COALESCE((SELECT CAST(value AS INTEGER)-10 FROM settings WHERE key='checkout_hold_minutes'),32))) AS TEXT),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER checkout_session_minutes_insert BEFORE INSERT ON settings WHEN NEW.key='checkout_session_minutes' AND (NEW.value='' OR NEW.value GLOB '*[^0-9]*' OR CAST(CAST(NEW.value AS INTEGER) AS TEXT)!=NEW.value OR CAST(NEW.value AS INTEGER)<32 OR CAST(NEW.value AS INTEGER)>1440) BEGIN SELECT RAISE(ABORT,'Invalid checkout Session duration'); END;
--> statement-breakpoint
CREATE TRIGGER checkout_session_minutes_update BEFORE UPDATE ON settings WHEN NEW.key='checkout_session_minutes' AND (NEW.value='' OR NEW.value GLOB '*[^0-9]*' OR CAST(CAST(NEW.value AS INTEGER) AS TEXT)!=NEW.value OR CAST(NEW.value AS INTEGER)<32 OR CAST(NEW.value AS INTEGER)>1440) BEGIN SELECT RAISE(ABORT,'Invalid checkout Session duration'); END;
--> statement-breakpoint
CREATE TRIGGER authorized_allocation_release_guard BEFORE UPDATE OF status ON reservations WHEN OLD.status='active' AND NEW.status IN ('released','expired') AND EXISTS(SELECT 1 FROM checkout_intents ci WHERE ci.order_id=OLD.order_id AND ci.allocation_id IS NOT NULL AND ci.payment_state NOT IN ('canceled','captured','finalized')) BEGIN SELECT RAISE(ABORT,'Capture outcome must be resolved before allocation release'); END;
--> statement-breakpoint
CREATE TRIGGER manual_checkout_allocation_guard BEFORE UPDATE OF allocation_id ON checkout_intents WHEN NEW.allocation_id IS NOT NULL AND OLD.allocation_id IS NULL AND (NEW.quote_confirmed_at IS NULL OR NEW.cancel_requested!=0 OR NEW.superseded_by IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Checkout cannot allocate inventory'); END;

--> statement-breakpoint
CREATE INDEX `checkout_authorization_age_idx` ON `checkout_intents` (`authorized_at`) WHERE "checkout_intents"."payment_state" NOT IN ('finalized','canceled') AND "checkout_intents"."authorized_at" IS NOT NULL;

-- Bump the commerce revision only when a variant column that a checkout quote reads changes.
DROP TRIGGER IF EXISTS `commerce_revision_variants_update`;
--> statement-breakpoint
CREATE TRIGGER `commerce_revision_variants_update` AFTER UPDATE ON `variants` WHEN NEW.sku IS NOT OLD.sku OR NEW.product_id IS NOT OLD.product_id OR NEW.price_cents IS NOT OLD.price_cents OR NEW.weight_grams IS NOT OLD.weight_grams OR NEW.status IS NOT OLD.status OR NEW.continue_selling IS NOT OLD.continue_selling BEGIN UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'commerce_revision'; END;

-- Reindex the admin search tables only when an indexed column changes.
DROP TRIGGER IF EXISTS `orders_fts_au`;
--> statement-breakpoint
CREATE TRIGGER `orders_fts_au` AFTER UPDATE OF `number`, `customer_email` ON `orders` WHEN old.`number` IS NOT new.`number` OR old.`customer_email` IS NOT new.`customer_email` BEGIN DELETE FROM `orders_fts` WHERE rowid = old.rowid; INSERT INTO `orders_fts`(rowid, `number`, `customer_email`) VALUES (new.rowid, new.`number`, new.`customer_email`); END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `discounts_fts_au`;
--> statement-breakpoint
CREATE TRIGGER `discounts_fts_au` AFTER UPDATE OF `code` ON `discounts` WHEN old.`code` IS NOT new.`code` BEGIN DELETE FROM `discounts_fts` WHERE rowid = old.rowid; INSERT INTO `discounts_fts`(rowid, `code`) VALUES (new.rowid, new.`code`); END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `posts_fts_au`;
--> statement-breakpoint
CREATE TRIGGER `posts_fts_au` AFTER UPDATE OF `title` ON `posts` WHEN old.`title` IS NOT new.`title` BEGIN DELETE FROM `posts_fts` WHERE rowid = old.rowid; INSERT INTO `posts_fts`(rowid, `title`) VALUES (new.rowid, new.`title`); END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `pages_fts_au`;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_au` AFTER UPDATE OF `title` ON `pages` WHEN old.`title` IS NOT new.`title` BEGIN DELETE FROM `pages_fts` WHERE rowid = old.rowid; INSERT INTO `pages_fts`(rowid, `title`) VALUES (new.rowid, new.`title`); END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `media_fts_au`;
--> statement-breakpoint
CREATE TRIGGER `media_fts_au` AFTER UPDATE OF `filename` ON `media` WHEN old.`filename` IS NOT new.`filename` BEGIN DELETE FROM `media_fts` WHERE rowid = old.rowid; INSERT INTO `media_fts`(rowid, `filename`) VALUES (new.rowid, new.`filename`); END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `collections_fts_au`;
--> statement-breakpoint
CREATE TRIGGER `collections_fts_au` AFTER UPDATE OF `title` ON `collections` WHEN old.`title` IS NOT new.`title` BEGIN DELETE FROM `collections_fts` WHERE rowid = old.rowid; INSERT INTO `collections_fts`(rowid, `title`) VALUES (new.rowid, new.`title`); END;

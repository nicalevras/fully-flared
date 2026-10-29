-- Admin list search: FTS5 indexes so toolbar search is index-served instead of
-- LIKE '%term%' full scans (D1 bills rows read as rows scanned). Standalone
-- FTS tables synced by triggers, same shape as products_fts in 0027.
-- Trigram tokenizer keeps substring semantics for codes/emails/filenames;
-- All six use trigram: one substring rule everywhere. Terms under 3 chars
-- fall back to LIKE in the query code (trigram minimum).
CREATE VIRTUAL TABLE `orders_fts` USING fts5(`number`, `customer_email`, tokenize='trigram');
--> statement-breakpoint
INSERT INTO `orders_fts`(rowid, `number`, `customer_email`) SELECT rowid, `number`, `customer_email` FROM `orders`;
--> statement-breakpoint
CREATE TRIGGER `orders_fts_ai` AFTER INSERT ON `orders` BEGIN INSERT INTO `orders_fts`(rowid, `number`, `customer_email`) VALUES (new.rowid, new.`number`, new.`customer_email`); END;
--> statement-breakpoint
CREATE TRIGGER `orders_fts_au` AFTER UPDATE ON `orders` BEGIN DELETE FROM `orders_fts` WHERE rowid = old.rowid; INSERT INTO `orders_fts`(rowid, `number`, `customer_email`) VALUES (new.rowid, new.`number`, new.`customer_email`); END;
--> statement-breakpoint
CREATE TRIGGER `orders_fts_ad` AFTER DELETE ON `orders` BEGIN DELETE FROM `orders_fts` WHERE rowid = old.rowid; END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `discounts_fts` USING fts5(`code`, tokenize='trigram');
--> statement-breakpoint
INSERT INTO `discounts_fts`(rowid, `code`) SELECT rowid, `code` FROM `discounts`;
--> statement-breakpoint
CREATE TRIGGER `discounts_fts_ai` AFTER INSERT ON `discounts` BEGIN INSERT INTO `discounts_fts`(rowid, `code`) VALUES (new.rowid, new.`code`); END;
--> statement-breakpoint
CREATE TRIGGER `discounts_fts_au` AFTER UPDATE ON `discounts` BEGIN DELETE FROM `discounts_fts` WHERE rowid = old.rowid; INSERT INTO `discounts_fts`(rowid, `code`) VALUES (new.rowid, new.`code`); END;
--> statement-breakpoint
CREATE TRIGGER `discounts_fts_ad` AFTER DELETE ON `discounts` BEGIN DELETE FROM `discounts_fts` WHERE rowid = old.rowid; END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `posts_fts` USING fts5(`title`, tokenize='trigram');
--> statement-breakpoint
INSERT INTO `posts_fts`(rowid, `title`) SELECT rowid, `title` FROM `posts`;
--> statement-breakpoint
CREATE TRIGGER `posts_fts_ai` AFTER INSERT ON `posts` BEGIN INSERT INTO `posts_fts`(rowid, `title`) VALUES (new.rowid, new.`title`); END;
--> statement-breakpoint
CREATE TRIGGER `posts_fts_au` AFTER UPDATE ON `posts` BEGIN DELETE FROM `posts_fts` WHERE rowid = old.rowid; INSERT INTO `posts_fts`(rowid, `title`) VALUES (new.rowid, new.`title`); END;
--> statement-breakpoint
CREATE TRIGGER `posts_fts_ad` AFTER DELETE ON `posts` BEGIN DELETE FROM `posts_fts` WHERE rowid = old.rowid; END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `pages_fts` USING fts5(`title`, tokenize='trigram');
--> statement-breakpoint
INSERT INTO `pages_fts`(rowid, `title`) SELECT rowid, `title` FROM `pages`;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_ai` AFTER INSERT ON `pages` BEGIN INSERT INTO `pages_fts`(rowid, `title`) VALUES (new.rowid, new.`title`); END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_au` AFTER UPDATE ON `pages` BEGIN DELETE FROM `pages_fts` WHERE rowid = old.rowid; INSERT INTO `pages_fts`(rowid, `title`) VALUES (new.rowid, new.`title`); END;
--> statement-breakpoint
CREATE TRIGGER `pages_fts_ad` AFTER DELETE ON `pages` BEGIN DELETE FROM `pages_fts` WHERE rowid = old.rowid; END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `media_fts` USING fts5(`filename`, tokenize='trigram');
--> statement-breakpoint
INSERT INTO `media_fts`(rowid, `filename`) SELECT rowid, `filename` FROM `media`;
--> statement-breakpoint
CREATE TRIGGER `media_fts_ai` AFTER INSERT ON `media` BEGIN INSERT INTO `media_fts`(rowid, `filename`) VALUES (new.rowid, new.`filename`); END;
--> statement-breakpoint
CREATE TRIGGER `media_fts_au` AFTER UPDATE ON `media` BEGIN DELETE FROM `media_fts` WHERE rowid = old.rowid; INSERT INTO `media_fts`(rowid, `filename`) VALUES (new.rowid, new.`filename`); END;
--> statement-breakpoint
CREATE TRIGGER `media_fts_ad` AFTER DELETE ON `media` BEGIN DELETE FROM `media_fts` WHERE rowid = old.rowid; END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `collections_fts` USING fts5(`title`, tokenize='trigram');
--> statement-breakpoint
INSERT INTO `collections_fts`(rowid, `title`) SELECT rowid, `title` FROM `collections`;
--> statement-breakpoint
CREATE TRIGGER `collections_fts_ai` AFTER INSERT ON `collections` BEGIN INSERT INTO `collections_fts`(rowid, `title`) VALUES (new.rowid, new.`title`); END;
--> statement-breakpoint
CREATE TRIGGER `collections_fts_au` AFTER UPDATE ON `collections` BEGIN DELETE FROM `collections_fts` WHERE rowid = old.rowid; INSERT INTO `collections_fts`(rowid, `title`) VALUES (new.rowid, new.`title`); END;
--> statement-breakpoint
CREATE TRIGGER `collections_fts_ad` AFTER DELETE ON `collections` BEGIN DELETE FROM `collections_fts` WHERE rowid = old.rowid; END;

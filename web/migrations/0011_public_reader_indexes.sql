CREATE INDEX `collections_title_id_idx` ON `collections` (`title`,`id`);--> statement-breakpoint
CREATE INDEX `posts_status_published_id_idx` ON `posts` (`status`,`published_at`,`id`);
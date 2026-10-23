CREATE TABLE `cache_purge_gate` (
	`id` integer PRIMARY KEY NOT NULL,
	`tokens` real NOT NULL,
	`refilled_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO cache_purge_gate(id,tokens,refilled_at) VALUES(1,25,0);

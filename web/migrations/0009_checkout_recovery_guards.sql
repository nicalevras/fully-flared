ALTER TABLE `checkout_intents` ADD `first_provider_attempt_at` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `provider_step` text;--> statement-breakpoint
ALTER TABLE `checkout_intents` ADD `creation_stopped_at` text;
--> statement-breakpoint
-- Legacy in-flight attempts have no reliable first-attempt evidence. Preserve
-- retrieval/webhook recovery, but never replay their creation POSTs.
UPDATE checkout_intents SET creation_stopped_at=COALESCE(creation_stopped_at,datetime('now')),
first_provider_attempt_at=COALESCE(first_provider_attempt_at,created_at)
WHERE state IN ('session_creating','reconciliation_required');

-- Serves the checkout POST lookup of intents a new intent superseded, in created order.
CREATE INDEX `checkout_intents_superseded_idx` ON `checkout_intents` (`superseded_by`,`created_at`) WHERE "checkout_intents"."superseded_by" IS NOT NULL;

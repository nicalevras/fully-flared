-- Email claims run to MAX_EMAIL_ATTEMPTS (8), so the claim index must cover every claimable row.
DROP INDEX `outbox_claim_due_idx`;--> statement-breakpoint
CREATE INDEX `outbox_claim_due_idx` ON `outbox` (`status`,`claimed_at`,`id`) WHERE "outbox"."attempts"<8;
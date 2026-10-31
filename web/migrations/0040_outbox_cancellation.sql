DROP INDEX `outbox_claim_due_idx`;--> statement-breakpoint
CREATE INDEX `outbox_claim_due_idx` ON `outbox` (`status`,`claimed_at`,`id`);
--> statement-breakpoint
DROP TRIGGER outbox_status_guard_insert;
--> statement-breakpoint
DROP TRIGGER outbox_status_guard_update;
--> statement-breakpoint
CREATE TRIGGER outbox_status_guard_insert BEFORE INSERT ON outbox
WHEN NEW.status NOT IN ('pending','sending','sent','failed','canceled')
BEGIN SELECT RAISE(ABORT, 'invalid outbox status'); END;
--> statement-breakpoint
CREATE TRIGGER outbox_status_guard_update BEFORE UPDATE ON outbox
WHEN NEW.status NOT IN ('pending','sending','sent','failed','canceled')
BEGIN SELECT RAISE(ABORT, 'invalid outbox status'); END;

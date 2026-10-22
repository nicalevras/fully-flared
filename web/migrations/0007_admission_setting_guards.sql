-- SQL-side range guards for the checkout admission budgets, mirroring
-- settings_limit_guard (0000) and the Zod ranges in schemas/limits.ts:
-- admission_starts_per_second 1-100, admission_burst 1-200,
-- admission_max_active 1-200. Until this migration the keys were
-- validated only in the admin action layer, so a direct D1 write could
-- store an out-of-range budget.
CREATE TRIGGER settings_admission_guard_insert BEFORE INSERT ON settings
WHEN NEW.key IN ('admission_starts_per_second','admission_burst','admission_max_active') AND (NEW.value='' OR NEW.value GLOB '*[^0-9]*' OR CAST(CAST(NEW.value AS INTEGER) AS TEXT)!=NEW.value OR CAST(NEW.value AS INTEGER)<1 OR CAST(NEW.value AS INTEGER)>CASE NEW.key WHEN 'admission_starts_per_second' THEN 100 ELSE 200 END)
BEGIN SELECT RAISE(ABORT,'invalid admission setting'); END;--> statement-breakpoint
CREATE TRIGGER settings_admission_guard_update BEFORE UPDATE OF key,value ON settings
WHEN NEW.key IN ('admission_starts_per_second','admission_burst','admission_max_active') AND (NEW.value='' OR NEW.value GLOB '*[^0-9]*' OR CAST(CAST(NEW.value AS INTEGER) AS TEXT)!=NEW.value OR CAST(NEW.value AS INTEGER)<1 OR CAST(NEW.value AS INTEGER)>CASE NEW.key WHEN 'admission_starts_per_second' THEN 100 ELSE 200 END)
BEGIN SELECT RAISE(ABORT,'invalid admission setting'); END;

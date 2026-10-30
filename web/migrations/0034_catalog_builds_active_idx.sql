-- Lets GC's live-build checks skip retained terminal builds.
CREATE INDEX `catalog_builds_active_idx` ON `catalog_builds` (`state`) WHERE "catalog_builds"."state" NOT IN ('done','acknowledged','failed','canceled');

-- Lets the invalidation drain delete a chunk's rows by (scope, scope_id) lookup.
CREATE INDEX `catalog_invalidations_scope_idx` ON `catalog_invalidations` (`scope`,`scope_id`);

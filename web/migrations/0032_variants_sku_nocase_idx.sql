-- Serves the case-insensitive SKU prefix LIKE in admin inventory search.
CREATE INDEX `variants_sku_nocase_idx` ON `variants` (`sku` COLLATE NOCASE);

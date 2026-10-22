# Reconciliation soak log

Started at first production deploy; 14 consecutive CLEAN days required before launch (plan Step 9). Each row is one `scripts/reconcile.mjs` run.

| Date       | Time      | Result                                | Detail                                                                                                                                                                                    |
| ---------- | --------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-18 | 00:04:25Z | FAILED: stock counters == ledger sums | all SKUs agree; TEE-BLK-M,TEST-1792281645051,IMP-TEE-1792281645165; paid orders have no active holds; stock never negative / never over-reserved; none older than 35m; SKIP (no real key) |
| 2026-10-18 | 00:05:40Z | CLEAN                                 | all SKUs agree; all SKUs agree; paid orders have no active holds; stock never negative / never over-reserved; none older than 35m; SKIP (no real key)                                     |

Restore rehearsal 2026-10-17 (local): full-schema export does not re-import on an empty D1 (foreign-key table order). Verified method: apply migrations in order, then import a data-only export (`wrangler d1 export --no-schema`). Export 2.71s, data restore 2.87s, restored counts products=3 settings=12 ledger=3 users=1 (matches source at rehearsal time).
| 2026-10-18 | 02:01:06Z | CLEAN | all SKUs agree; all SKUs agree; paid orders have no active holds; stock never negative / never over-reserved; none older than 35m; SKIP (no real key) |
| 2026-10-18 | 02:56:57Z | CLEAN | all SKUs agree; all SKUs agree; paid orders have no active holds; stock never negative / never over-reserved; none older than 35m; SKIP (no real key) |
| 2026-10-18 | 02:57:23Z | CLEAN | all SKUs agree; all SKUs agree; paid orders have no active holds; stock never negative / never over-reserved; none older than 35m; SKIP (no real key) |
| 2026-10-18 | 03:41:44Z | CLEAN | all SKUs agree; all SKUs agree; paid orders have no active holds; stock never negative / never over-reserved; none older than 35m; SKIP (no real key) |
| 2026-10-18 | 03:46:37Z | CLEAN | all SKUs agree; all SKUs agree; paid orders have no active holds; stock never negative / never over-reserved; none older than 35m; SKIP (no real key) |

Restore rehearsal 2026-10-18 (local, FTS-era): fresh backup (7 products / 43 orders at export) imported standalone into an empty SQLite scratch file, FTS5 index recreated from migration 0003 statements. All invariant checks green: row counts match export-time source, stock == stock_ledger sums for every SKU, no negative stock, no dangling order items, FTS MATCH returns products. Note: the earlier migrations-first method predates the table-scoped export; the proven order is import-first, then recreate FTS.

Production soak: NOT STARTED. The 14-day clock starts at the first production deployment with daily reconcile runs against the live database. Blocker: no deployment has been made (deploying is the owner's call; wrangler is logged in locally as the owner). Local reconcile history above is pre-production evidence only and does not count toward the 14 days.
| 2026-10-18 | 03:50:22Z | CLEAN | all SKUs agree; all SKUs agree; paid orders have no active holds; stock never negative / never over-reserved; none older than 35m; SKIP (no real key) |
| 2026-10-18 | 13:12:45Z | CLEAN | all SKUs agree; all SKUs agree; paid orders have no active holds; stock never negative / never over-reserved; none older than 35m; SKIP (no real key) |

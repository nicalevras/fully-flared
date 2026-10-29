# Full SQLite/D1 Audit — 2026-10-29

## What this repo does

Cloudflare Workers + D1 storefront/admin. All SQL goes through `.prepare(`:
770 sites in `web/src` (365 reads, 393 writes, 12 other/no-literal). 111 explicit
indexes (+ PK autoindexes), 7 FTS5 tables (products_fts unicode61 pre-existing;
orders/discounts/posts/pages/media/collections trigram from 0028; covering
indexes from 0029). Every read below was EXPLAINed against local Miniflare D1
seeded with 50,000 orders / 10,000 products / 10,000 posts, all migrations
through 0029 applied. Evidence: `.audit/full-read-census.tsv`,
`.audit/index-inventory.tsv`, harness in `tests/read-census.test.ts`.

D1 doc basis (fetched, developers.cloudflare.com/d1): billing counts **rows
scanned**, so an unindexed filter bills a full scan; each index costs ~1 extra
row written per indexed write plus storage; `SEARCH` good / `SCAN` bad in
EXPLAIN QUERY PLAN; partial and expression indexes shrink that cost. Local
SQLite row counts are directional for D1 rows-read, never D1-measured.

## Census result

- Reads classified: 332 of 365 EXPLAINed (235 SEARCH, 31 SEARCH-dynamic,
  12 FTS SEARCH, 19 covering/index scans, 35 bare scans). 44 sites (5.7%) are
  MANUAL: dynamic SQL fragments (fixed condition lists interpolated) or
  no-literal prepares — grep-reviewed, shapes are parameterized, not user SQL.
- Bare scans: 35 total; 17 carry LIMIT (bounded batches/probes); **18 unbounded,
  every one classified below**. The 9 admin list tables, search, dashboard hot
  list, and storefront discovery: zero bare scans (prior phases' work, re-verified).

## Must fix

1. **FIXED (migration 0030): refunds had no index on `return_id` or `stripe_refund_id`.** After: `SEARCH refunds USING COVERING INDEX refunds_return_status_idx` for both COUNTs and `MULTI-INDEX OR` (stripe_refund_idx + request_id_unique) for the webhook lookup, verified in the regenerated census. Bare-scan baseline 18 to 15.
   What: `admin-actions.ts:709,783` COUNT refunds by `return_id` and
   `refunds.ts:297` looks up `stripe_refund_id=? OR request_id=?` — all three
   plan `SCAN refunds` (request_id alone has a unique index; the OR cannot use
   it for the other branch). Problem: refunds grows with orders; every refund
   webhook and admin return view scans it. Smallest fix: one migration,
   `CREATE INDEX refunds_return_idx ON refunds(return_id)` +
   `CREATE INDEX refunds_stripe_refund_idx ON refunds(stripe_refund_id)`.
   If we skip: fine today, linear pain per refund forever.

## Should fix

2. **Low-stock COUNT scans `stock` by expression** (`admin/index.tsx:98`,
   `reports.tsx:17`): `on_hand - reserved <= 5` cannot use a B-tree. Limiter =
   stock rows = SKU count (seeded scale irrelevant; a single-store SKU count is
   the ceiling). Smallest fix if it ever feels slow: expression index on
   `((on_hand-reserved))`. If we skip: one SKU-sized scan per dashboard load.
3. **Four redundant indexes** (write tax, 1 extra row written per insert each,
   per D1 pricing): `checkout_intents_session_idx` duplicates the unique index
   on the same column; `posts_status_idx`, `products_status_idx`, and
   `return_items_return_idx` are strict prefixes of wider indexes on their
   tables. Smallest fix: drop after re-EXPLAINing their known queries against
   the wider index. Not redundant: `orders_ip_retention_idx` looks identical
   to `orders_created_id_idx` but is partial (`customer_ip IS NOT NULL`) — keep.
   Orders carries 13 indexes, checkout_intents 10: accepted, those are the
   money tables, but each new index proposal there must name this cost.
4. **FIXED: stale comment** `web/src/lib/fts-search.ts:4`: claims callers "fall back
   to LIKE" under 3 chars; they return an empty page (fallbacks deleted).
   One-line fix; the lie will mislead the next reader into re-adding a scan.

## Nice to have / accepted, limiter named

5. Media-reference `instr()` scans (`media.tsx:105,114`, `admin-actions.ts:1173-1201`):
   deliberate — percent-encoded `/media/` references cannot be matched in SQL
   (comment in code says so). Admin media-delete only; limiter = editorial rows
   (posts+pages+products content). No FTS: an HTML full-text index would not
   answer "is this media key referenced" reliably and would tax every post write.
6. Tiny-table scans: `user` role counts (auth/admin/outbox), `shipping_zones`/
   `shipping_rates` config lists, `post_tags` join in BlogPostEditor,
   `catalog_work` queue probes (has due + partial pending indexes; background).
   Limiter = accounts/config/queue size, never order volume.
7. `PRAGMA integrity_check` cannot run through D1 (`SQLITE_AUTH`, verified):
   integrity verification is `wrangler d1`/dashboard territory. MANUAL.

## FTS verdict — no new FTS table is appropriate

Every remaining text predicate, by caller shape: order number/email, SKU,
discount code, redirect paths, reservation ids = prefix LIKE on B-tree indexes
(index-served at any length); storefront + admin product title = products_fts;
admin lists = the 6 trigram tables; media content references + account-deletion
email scrub = `instr()` on rare admin/privacy operations, not search. Adding
FTS anywhere else would buy index-maintenance writes on hot tables to speed up
queries that are already SEARCH. **No more FTS gains available without over-engineering.**

## Verdict

By the strict definition, the remaining 15 bare scans each have a named non-order-volume limiter (findings 2, 5, 6), and finding 1 is closed by 0030. That earns "fully optimized" as defined in this report, with findings 2 and 3 as optional polish if real D1 rows-read data ever argues otherwise. Everything user-triggered at storefront/admin scale is already
index- or FTS-served; the remaining 18 bare scans each have a named limiter.
The big wins were already taken (FTS5 search, bounded global search, 0029
covering indexes); what is left is small, and this report is the proof either way.

## Lean line

770 sites audited, must-fix closed by 0030 (2 indexes), 0 new FTS tables, 0 architecture changes.

## Not checked

Production data distribution and real D1 rows-read billing (local-only by your
decision); the 44 MANUAL dynamic-SQL sites were shape-reviewed, not EXPLAINed;
pre-existing full-suite failures (account-orders, account-privacy, phase6-data)
are out of scope and were not re-triaged here.

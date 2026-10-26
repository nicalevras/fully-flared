# Products discovery verification

This document covers finding products in the admin. It preserves the merged admin shell and existing create, import, stock and editor actions. Editor redesign and persistent drafts remain later work.

## Behavior

Submit a title, exact SKU or SKU prefix. Typing and selecting a mode do not request data. SKU matching is case-sensitive. Title search requires all literal terms in the title, without exposing FTS operators. Results use newest creation date and ID ordering, 50 products per page. Search and cursor are stored in the URL. Both browser Back and the editor breadcrumb restore the filtered page.

Search discovery reads at most 1,001 candidates before deduplication, sorting and selected-page projection. More than 1,000 raw candidates produces the message "This search is too broad to display safely. Try a more specific title or SKU." The cap counts candidate rows before products are deduplicated. SKU candidates count variants, so one product with many matching variants can trigger this conservative limit even though only one product matches. The message never presents the raw candidate count as a product count. There is no exact total count or page-number jump. Cursor pagination is not a transactionally frozen snapshot while other staff edit products.

The existing full-count/offset admin query is removed. Public catalog queries and all commerce actions remain unchanged. No migration, index, dependency or infrastructure was added.

## Verification

- Discovery and admin safety tests pass, including searched Unicode cursor round trips, tied IDs, invalid/cross-query cursors, title-only matching, SKU casing, deduplication, a product with 1,000 variants and 50 media attachments, punctuation and malformed title input, a broad title search that refines and then succeeds when narrowed, an empty page returned for a cursor whose remaining rows were deleted, and malformed search parameters normalized to a safe search. The Products empty state for that deleted-cursor page offers a Back to first page action that keeps the committed search.
- Three real local workerd D1 probes passed at 10, 5,000 and 100,000 products. Regression ceilings apply to the controlled fixture's full browse calls and common-title discovery. They are not universal production budgets.
- Lint, type checking, migrations check, production build and the bundle boundary check passed. The bundle check runs against the fresh production build in the same session. Browser-safe search normalization lives in `web/src/lib/product-search.ts` with no imports. Zod validation stays in the server function boundary, so no Zod ships in the client bundle.
- Action feedback on the Products page uses the shared semantic success and error component from the merged admin shell, rendered below the page heading so table and form results stay visible. The list error state offers a Try again action.
- The compiled local preview passed exact SKU, prefix search, next/previous pages, editor return, browser Back, empty results, broad-search refinement and Enter submission. Typing and mode selection added zero local Worker GET/POST root requests before submission.
- Desktop, tablet, phone and 320px widths checked. The table scrolls inside a keyboard-focusable named region. At 320px, document width and scroll width both measured 320px.
- The remediation was rechecked over HTTP against the compiled local application with a disposable staff fixture. Browse, exact SKU, zero results, the new broad-search message and the signed-out redirect to sign-in returned the expected pages. Interactive keyboard, slow-network, injected-outage, permission-denial and screenshot checks were not rerun for the remediation in this environment. Loading and error components are present; existing staff and 2FA gates are unchanged and covered by the admin safety tests.

## Local resource evidence

[Recorded rows and query plans](resources.json) come from the runnable test below. The fixture has one active variant per product, no stock/media rows, a common title and an uncommon title.

| Logical operation at 100,000 products                | D1 rows read |
| ---------------------------------------------------- | -----------: |
| Previous first page, 100 cards plus count            |      799,999 |
| New first page, 50 cards including projection        |          399 |
| New page after 20 cursor pages, including projection |          402 |
| Exact SKU candidate hit / miss                       |        2 / 0 |
| Narrow / broad SKU prefix candidates                 |    3 / 2,002 |
| Narrow / common title candidates                     |    2 / 2,001 |

Counts cover list-function SQL, excluding staff/session/navigation queries and browser requests. This changes page size and query shape, so it is not a like-for-like latency comparison. The instrumented old Drizzle raw path performs an extra identical `all()` read to obtain D1 metadata, then executes the actual raw call. Reported counts represent each logical SQL statement once and exclude fixture setup and that instrumentation overhead. They are not total probe consumption.

Candidate limits bound application sorting and hydration, not all FTS internals. Price/stock/image projection still depends on child-row fanout. No deployed CPU, latency, checkout coexistence or monthly capacity claim is established. This read-only path adds no publication work by construction; KV, queues and purges were not measured as deployed zeros.

A bounded heavy page was added to the scale evidence. A full 50-product page where each product has 20 variants, 5 media attachments and stock for every variant read 4,047 D1 rows in 2 statements at the fixture size recorded by the test: 50 rows for the candidate query and 3,997 rows for the selected-page projection. Projection cost grows with child rows on the selected page and stays off the unselected catalog.

| Resource or claim                              | Classification | Evidence                                                                                    |
| ---------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| D1 rows read for browse, search and projection | Measured       | Local workerd fixtures at 10, 5,000 and 100,000 products, plus the heavy page above         |
| Query count per discovery call                 | Measured       | Two statements for a ready browse or search page; one statement when a broad search refines |
| Worker CPU and deployed latency                | Unavailable    | No deployed measurement was taken for this change                                           |
| Checkout coexistence p95 gate                  | Unavailable    | No authorized isolated deployed run; not claimed as passed                                  |
| KV, queue and purge work from discovery        | Not applicable | The change is a read path and introduces no writes, by construction                         |
| Monthly cost at the planning workload          | Projected      | Depends on the unavailable deployed CPU and latency figures; no new figure is claimed here  |

Reproduce from the repository root with Node 24:

```sh
DISCOVERY_100K=1 npm test -- tests/admin-product-discovery-scale.test.ts
npm test -- tests/admin-product-discovery.test.ts tests/admin-safety.test.ts
npm run lint
npm run typecheck
npm run build
cd web && npm run check:bundle
```

## Screenshots

All data shown is disposable local fixture data.

Before:

![Previous Products page](before.jpg)

After:

![Exact SKU search](after-desktop.jpg)

![Phone search results](after-mobile.jpg)

## Phase 2B: list presentation and filters

The Products list now filters by product status (All, Active, Draft, Archived) and sorts by Newest, Oldest, Title A-Z, or Recently updated. Status and sort are stored in the URL with the search and cursor. Changing either returns to the first page. Each row shows the active-variant price range (a single price when all active variants share one), the total variant count under the inventory state, and, for SKU searches, the matching SKUs with variant titles under the product title: the first three in SKU order, with a remainder count. There is still no total result count.

Recently updated sorts by the product record's `updated_at`. Editing a product or changing its status updates that timestamp. Editing a variant, stock, or media does not, so a variant price change may not move a product up the Recently updated list. A complete modification-timestamp contract is deferred to the product editing phase; no write behavior changed here.

### Ordering contract

Title order is SQLite `NOCASE` order wherever it is computed: ASCII letters fold to lowercase, ties break by product ID in binary order, and non-ASCII characters do not fold. The SQL browse queries, the application-side sort of capped search candidates, and both cursor directions use this one contract, implemented by the shared comparator in `web/src/lib/product-search.ts`. Cursors are version 2 and bind the query, mode, status, sort, sort key, and product ID. A version 1 cursor returns the first page with the committed search, status, and sort preserved.

### Indexes and cursor seeks (measured, local D1)

Two candidate shapes were rejected by measurement on the local workerd SQLite. A row-value title predicate `(title COLLATE NOCASE, id) > (?, ?)` and the equivalent expanded OR form both scanned the covering title index: 50,051 rows read for a mid-catalog page of 50 at 100,000 products. A strict `title COLLATE NOCASE > ?` bound seeks (51 rows read) but skips products that share the cursor's folded title. Title browse therefore seeks in two bounded branches, the equal-title remainder (`title COLLATE NOCASE = ? AND id > ?`) and strictly beyond (`title COLLATE NOCASE > ?`), merged by the shared comparator. Each branch reads at most 51 rows.

Migration `0019_product_list_sort_indexes.sql` adds five indexes, each justified by a query plan at 100,000 products with a 90/9/1 active/draft/archived distribution:

| Index | Justification |
| --- | --- |
| `products_title_id_idx (title COLLATE NOCASE, id)` | Unfiltered title sort. Baseline was a table scan plus temporary B-tree (149,999 rows read). |
| `products_updated_id_idx (updated_at, id)` | Unfiltered Recently updated. Baseline was a table scan plus temporary B-tree (149,999 rows read). |
| `products_status_created_id_idx (status, created_at, id)` | Status-filtered Newest and Oldest. Baseline used the status index plus a temporary B-tree (135,000 rows read for the common status). |
| `products_status_updated_id_idx (status, updated_at, id)` | Status-filtered Recently updated, same baseline failure. |
| `products_status_title_id_idx (status, title COLLATE NOCASE, id)` | Status-filtered Title A-Z, same baseline failure. |

With these indexes, every deep page tested (20 pages in; 5 pages in for the rare archived status, which holds 1,000 of the 100,000 products) reads 52 candidate rows (51 for the title branches) and 550 projection rows: 602 rows total, forward and backward, for all four sorts under All, the common status, and the rare status. The first page reads the same candidate figure, so deep pages cost what the first page costs. The projection figure is for one variant per product; the heavy-page fanout evidence above still applies to the projection.

The migration checker does not compare index collation, so `check:migrations` passing does not prove the `NOCASE` ordering. A test builds the schema from the migrations, reads both title index definitions from `sqlite_master`, and asserts `COLLATE NOCASE` is present, plus a query-plan assertion that the title seek uses `SEARCH`.

Matched SKUs come from the existing SKU candidate rows. The candidate queries already join variants; they now also return the matched SKU and variant title. Matches are grouped by product before deduplication, sorted by SKU in binary order, and capped at three with the remainder counted from the complete bounded candidate set. No extra query was added.

| Resource or claim | Classification | Evidence |
| --- | --- | --- |
| D1 rows read for filtered and sorted deep pages | Measured | Local workerd fixture at 100,000 products, recorded in `tests/admin-product-discovery-scale.test.ts` under `DISCOVERY_100K=1` |
| Query count per list call | Measured | Two statements for a ready page; three for a title-sorted browse page after the first (two seek branches plus projection) |
| Worker CPU, deployed latency, checkout coexistence | Unavailable | No deployed measurement; not claimed as passed |
| Write, KV, queue, and purge impact | Not applicable | Read path only, by construction |

Reproduce the deep-page evidence from the repository root:

```sh
DISCOVERY_100K=1 npm test -- tests/admin-product-discovery-scale.test.ts
npm test -- tests/admin-product-list-2b.test.ts
```

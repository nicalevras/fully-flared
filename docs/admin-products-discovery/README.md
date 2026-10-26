# Products discovery verification

This PR improves finding products. It preserves the merged admin shell and existing create, import, stock and editor actions. Status filters, editor redesign and persistent drafts remain later work.

## Behavior

Submit a title, exact SKU or SKU prefix. Typing and selecting a mode do not request data. SKU matching is case-sensitive. Title search requires all literal terms in the title, without exposing FTS operators. Results use newest creation date and ID ordering, 50 products per page. Search and cursor are stored in the URL. Both browser Back and the editor breadcrumb restore the filtered page.

Search discovery reads at most 1,001 candidates before deduplication, sorting and selected-page projection. More than 1,000 candidates produces an explicit refinement message. SKU candidates count variants, so one product with many matching variants can trigger this conservative limit. There is no exact total count or page-number jump. Cursor pagination is not a transactionally frozen snapshot while other staff edit products.

The existing full-count/offset admin query is removed. Public catalog queries and all commerce actions remain unchanged. No migration, index, dependency or infrastructure was added.

## Verification

- 36 tests passed across discovery and admin safety, including searched Unicode cursor round trips, tied IDs, invalid/cross-query cursors, title-only matching, SKU casing, deduplication and a product with 1,000 variants and 50 media attachments.
- Three real local workerd D1 probes passed at 10, 5,000 and 100,000 products. Regression ceilings apply to the controlled fixture's full browse calls and common-title discovery. They are not universal production budgets.
- Lint, type checking, production build and diff checks passed.
- The compiled local preview passed exact SKU, prefix search, next/previous pages, editor return, browser Back, empty results, broad-search refinement and Enter submission. Typing and mode selection added zero local Worker GET/POST root requests before submission.
- Desktop, tablet, phone and 320px widths checked. The table scrolls inside a keyboard-focusable named region. At 320px, document width and scroll width both measured 320px.
- Two independent source reviews found no material blocking findings. Slow-network loading and an injected server outage were not exercised in the browser. Loading and error components are present; existing staff/2FA gates are unchanged.

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

Reproduce from the repository root with Node 24:

```sh
DISCOVERY_100K=1 npm test -- tests/admin-product-discovery-scale.test.ts
npm test -- tests/admin-product-discovery.test.ts tests/admin-safety.test.ts
npm run lint
npm run typecheck
npm run build
```

## Screenshots

All data shown is disposable local fixture data.

Before:

![Previous Products page](before.jpg)

After:

![Exact SKU search](after-desktop.jpg)

![Phone search results](after-mobile.jpg)

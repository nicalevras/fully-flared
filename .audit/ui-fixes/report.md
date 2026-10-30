# Persistent table, overlay, and search fixes

What this repo does: Store is a single-store commerce app on Cloudflare Workers. Staff manage the catalog, orders, stock and content; shoppers browse and search published products. This audit covered the affected UI flows and their shared consumers, assuming concurrent staff and shopper sessions.

## Implemented

- All nine admin list pages retain tables, headers, toolbars and available actions at zero rows and zero search results. Dashboard recent orders, per-zone shipping rates, SKU movement history, and returns within the returns view also retain their tables.
- Empty messages live in table body rows. Products retain broad-query explanations, reset filters and cursor recovery. Visible leaf columns determine empty-cell spans. Zero-total offset pagination displays Page 0 of 0 and disables navigation; custom cursor footers remain route-owned.
- Expanded editors use a Base UI body portal outside drawer transforms and retain the same mounted editor host. Pages and articles reuse the shared expanded editor. Confirmations use Base UI AlertDialog and preserve existing callback interfaces, Cancel-first focus and busy blocking.
- The storefront palette uses Base UI modal behavior. Successful suggestions and in-flight requests survive close/reopen. Failures can retry on reopening. Query-owned results and errors prevent stale cards from activating after the input changes.
- Independent review found an interaction between expanded editor z60 and editor popup menus z50, confirmed in the browser. Expanded editor portals now share z50 and appear after their parent drawer. Later editor menus remain above them; confirmations retain z60. Native Radix Escape callbacks stop propagation while preserving Radix dismissal and caller callbacks, preventing a parent Base UI dialog from also closing.

## Verification

42 unique focused tests passed across 10 files. This combines the final 29-test fast UI/resource run with 13 real D1/global-search tests. Build, typecheck, formatting and diff whitespace checks passed. Scoped ESLint passed with zero warnings. Full lint still reports the same pre-existing 29 errors and 10 warnings, including tracked audit scripts and missing react-hooks/exhaustive-deps rule definitions.

Browser verification on localhost:8799 established the following.

- Before fixing, a no-match product query removed its table and search. After fixing, the same query retains the full header, search and New action.
- All nine admin lists render their tables and search fields. Empty Collections and Discounts each retain New and open their creation drawer. Empty Orders retains filters, column controls and recovery actions.
- Expanded editor width changed from 622 pixels on a 2560-pixel viewport to 2497 pixels, outside the drawer. Undo survives expanding and Done; child Escape leaves the drawer open.
- Dirty-close confirmation is outside the transformed drawer, centered in the viewport and initially focuses Cancel. Cancel retains edits; discard closes without saving.
- Heading and list menus are visible above the expanded editor; selecting Heading 2 changes editor markup. Escape closes list/link popups while retaining the expanded dialog. A discount Type select also closes with Escape while its parent drawer stays open.
- A temporary two-second delay reproduced the interrupted-suggestions bug. With the fix, close/reopen after that request shows six suggestions. Temporary delay instrumentation was removed.
- Palette Tab navigation stays inside the modal. Escape works from its Close control. Typing shirt after tee and immediately pressing Enter does not navigate to the stale Tee result. Reopening adopts cached suggestions.

Screenshot: orders-empty.png.

## Blast radius

The safety facts were checked with real code and the browser. TanStack accepts empty data and retains its header model. Custom cursor footers bypass the offset-page display. Body-portaled child dialogs remain nested in the React tree, and the browser demonstrated both full-viewport geometry and topmost dismissal. Independent review checked unchanged route data loading, permission gates, bulk selection and pagination handlers and approved the final fixes.

No new application dependencies, server endpoints, migrations, commits, deployment or production data changes. The pre-existing generated route-tree modification remains untouched. No browser test runner was added.

## Audit verdict and limits

Verdict: The scoped findings are fixed and independent review approved the final source. No further concrete bug was found in the affected flows. Full lint remains red on its documented baseline.

Not checked: A live image upload during expansion, a separate restricted-role browser login, and production services. Busy/upload callback wiring and permission gates were inspected, but those specific scenarios are not claimed as browser-tested. The full repository and full test suite were outside this affected-flow audit.

## Principles and cleanup

Model the Domain shaped the query-tagged result/error union and shared suggestions resource. Fix Root Causes kept tables mounted instead of adding duplicate creation buttons. Prove It Works required the same-surface browser checks and real build. Test Behavior, Not Implementation shaped the new rendered-output table tests and deferred-request tests. Deslop removed duplicated editor overlay code, avoided broad refactors and introduced no suppressions or unsafe casts. The no-comments review was report-only and deleted no comments.

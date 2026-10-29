# Fully Flared admin overhaul, Gate 0 approval package

Gate 0 collected local evidence against remote main `6339f228c3dd7b9a71442d0983b73695bdab306e`. No application-code, production-data or infrastructure changes were made by this audit. The pre-existing dirty checkout was preserved, subject to the provenance limits in [source-boundary.md](evidence/source-boundary.md). No feature PR was opened. The original working checkout and its pre-existing edits were preserved.

**Decision requested after review.** Approve a visual direction and the first bounded workflow. Do not approve production capacity from these results. The proposed checkout-under-admin performance gate is still open.

## What the audit establishes

| Evidence | Result | Boundary |
|---|---|---|
| Baseline merchant screens | Six surfaces captured at desktop, tablet and mobile; content save and shipment walked through | Disposable local data; real 2FA challenge and external email delivery not tested |
| Search | Exact SKU/order number read one row; late SKU LIKE scanned 99,920; range lookup read 20; broad FTS read 300,000 | Real workerd D1 with 100k products, one variant per product and broad tied title fixture |
| Publication | Three published saves used 15 KV puts and 3 purge callbacks; one reviewed submission used 5 and 1 | Five trials per mode, 30-product fixture, fake KV/purge endpoint, real publisher and D1 |
| Bulk publication | 25 variants of one product used 5 KV puts; 20 products used 100 | One drained purge callback in both; row fanout differs despite one logical operation |
| Checkout coexistence | 160 domain checkouts completed without errors; stock ledgers reconciled | Local database/domain probe, not HTTP, admission DO, Stripe or deployed capacity |
| Performance gate | Local proxies at concurrency 1 and 5 exceeded the proposed 10% degradation ceiling | Do not waive; 10-way result is noisy and not a production pass |
| Correctness designs | Five SQL primitive checks pass for stale save rejection, child revisions, stock replay, payload mismatch and rollback | In-memory SQLite, not concurrent D1/server-action proof |
| Budget | Official service rates and sensitivity worksheet provided | No fabricated total bill or measured geographic cache ratio |

[Full measurements](resources/measurements.md), [raw samples and query plans](resources/results.json), [cost worksheet](resources/monthly-budget.md), [reproduction instructions](resources/README.md).

The small catalog publication experiment supports one explicit submission per editing task. It does not establish the same savings at 100k products, with collection rules or media fanout. Existing publisher coalescing can already eliminate some intermediate work. IndexedDB adds recovery, not another backend saving.

## Merchant experience and visual direction

The first native-HTML design was rejected by the owner as generic and insufficiently faithful to the supplied x.ai reference. It is retained under `design/` only as rejected exploration. Do not implement its summary cards, slogans, symbolic imagery or fake dashboard framing.

The replacement under `design-v2/` uses existing shadcn components, Geist and Lucide. It follows the reference through a white canvas, sparse navigation, restrained typography, fine table rules and black primary actions. Products and Orders organize merchant tasks without stacking unrelated creation, import, inventory and refund forms under tables. Visual acceptance remains the owner's decision.

Compare full record workspaces with contextual Sheets. Prefer full workspaces unless browser tasks establish a meaningful benefit for panels. Keep sheets for narrow tasks where they help. Both initial comparison paths required two input/action steps for exact-SKU lookup and four for email-to-shipment, excluding optional tracking. No merchant usability study or statistically meaningful timing comparison occurred.

[Baseline walkthroughs and screenshot map](evidence/walkthroughs.md), [current screenshots](evidence/gallery.html), [replacement design](design-v2/dist/index.html), [replacement browser checks](evidence/v2-verification.md).

## Architecture and correctness decisions

Keep D1 authoritative and preserve authorization, 2FA, Stripe idempotency, inventory reservations, transactional work capture, KV publication, purge pacing and recovery. Add no queue, Durable Object, periodic job or standalone tracking service.

- **Search.** Separate indexed SKU lookup from title full-text search. Define prefix casing and ordering, then use verified range seeks. Broad FTS sorting still needs a measured result-order design before 100k admin search ships.
- **Content save.** Use one reviewed per-record submission and send changed fields. Evaluate existing catalog work revisions as the atomic CAS token. Product tokens cover variant and attachment mutations, but not every collection or shared-media change; scope ownership explicitly.
- **Stock.** Introduce deterministic operation/SKU ledger receipts with a canonical payload fingerprint and transaction-gated update. Put audit insertion in the same atomic unit. Return per-item outcomes; do not silently change the current all-or-nothing variant command into partial success. Initially support deltas, not set-count races.
- **Publication.** Return an accepted revision. Distinguish accepted, publishing, delivered and propagating. Reconcile existing state on open, focus and events. Processed work alone cannot prove reference delivery or global visibility. If exact correlation is unproven, show conservative pending status instead of a false Live badge.
- **Pricing.** Price drafts remain deferred. Current authoritative D1 checkout can see a new price before storefront publication. A later workflow needs an approved shopper re-confirmation contract; do not weaken checkout validation.
- **Customers.** Email grouping is contact search, not authentication or order ownership. Label account and guest history separately. Do not automatically attach notes to an email-only person or extend account deletion to unrelated guest orders. Add owner-reviewed guest export/erasure scope before unified profiles.
- **Rich content.** Reuse the sanitizer. Preserve plain-text descriptions and search text; introduce optional sanitized HTML only in its feature migration, with publisher compatibility and storefront fallback in the same PR.

[Architecture map, permission/query ownership and complete contracts](architecture/contracts.md), [baseline source hashes](architecture/baseline-provenance.json), [primitive proof results](architecture/contract-primitives-results.json).

## Resource acceptance and unresolved evidence

Model 100k products, 1m monthly visits, 10k orders and 10 active staff. Three views per visit yields 3m page views before API, media and background requests. The $5 subscription is a baseline with measured growth charges allowed. Account-wide service allowances may be shared.

The local checkout proxy had median batch maxima of 38.89ms baseline versus 210.04ms with ten admin-shaped jobs at concurrency 1, and 155.73ms versus 288.00ms at concurrency 5. These are not stable production p95 estimates. The result is sufficient to keep the proposed performance gate closed, not to select an infrastructure fix. Start with narrower list projections, on-demand returns/history, fewer repeated counts, scoped refresh and bounded bulk concurrency.

Twenty local HTTP full-body reads across Home, Shop, Product and Blog completed successfully. First-pass and repeated requests are recorded, but Vite compilation, local KV state and absent geographic edge caches prevent a genuine deployed cold/warm comparison. [HTTP samples](evidence/http-baseline.json).

Outstanding before production capacity acceptance:

1. Isolated deployed HTTP checkout with sufficient successful samples, ten authenticated staff sessions at a declared cadence, and no production traffic.
2. Worker CPU, D1 rows for full checkout/publishing, DO duration, real queue delivery/retry counts and actual purge telemetry.
3. Warm/cold geographic cache behavior, media size and delivery costs, imports/publication/reports coexecuting through the HTTP boundary.
4. Full 100k publication and many-variant/media/collection fanout. The 100k search fixture does not establish that capacity.
5. Browsers and assistive technologies beyond the focused local keyboard/mobile checks.

No isolated deployed environment was provisioned or modified. These gaps are explicit unavailable evidence, never measured zeros.

## Proposed PR order after approval

1. Responsive shell and shared feedback, proved through order navigation.
2. Indexed Products search, filters and stable pagination.
3. Draft product creation with six variants and media.
4. Reviewed product-content Save/Publish; rich descriptions and variant pricing in separate follow-ups.
5. Single-SKU retry-safe adjustment/history, then bounded multi-SKU adjustments.
6. Orders search and fulfillment queue.
7. Order detail, packing slips and shipment.
8. Bounded batch fulfillment with uncertain-outcome recovery.
9. Account/guest contact lookup after privacy approval; erasure separately.
10. Editorial editing, followed by persistent drafts only if recovery value justifies the added contract.
11. Collections, discounts, shipping and settings as separate workflows.
12. Date-correct dashboard, then reconciled period analytics.

Inventory and Orders can proceed independently of rich descriptions and editorial persistence. Every workflow removes its obsolete forms and includes behavioral checks, browser screenshots, keyboard/mobile completion and resource comparisons for the resources it touches. [Detailed boundaries and dependencies](architecture/implementation-sequence.md).

Pstack's Experience First caused the rejected design to be replaced and keeps the target on merchant tasks. Laziness Protocol favors existing components, revisions and publisher records. Sequence Work into Verifiable Units separates search, creation, content, inventory and fulfillment instead of one broad rewrite.

## Review and approval boundary

Independent review results are recorded in [review.md](review.md). Findings are classified as Act on, Consider, Noted or Dismissed. Source, raw samples, screenshots and limitations take precedence over any completion summary.

Gate 0 delivers an approval package, not a launch certification. Feature work stays closed until the owner approves the resulting design and implementation scope. Checkout capacity and any unavailable deployed measurements remain open regardless of visual approval.

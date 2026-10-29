# Gate 0 resource evidence

## Verdict and provenance

VERIFIED for local operation counts and query plans. INCONCLUSIVE for production latency, Worker CPU, total monthly cost and the proposed checkout-under-admin gate. No production request was sent.

Source is remote main `6339f228c3dd7b9a71442d0983b73695bdab306e`, executed from the isolated `/tmp/fully-flared-gate0-baseline` archive. Current checkout `f5689118…` and pre-existing local edits were not the benchmark source. Dependencies are the installed workspace packages symlinked into the archive. This is a source-isolated test, not an independently restored locked dependency install.

Read `results.json` for every sample, SQL text, query plan and D1 metadata. Run `sh .audit/gate0/resources/run.sh` from the repository root after restoring the baseline archive. Audit files are outside the application. Each test creates its own ephemeral Miniflare D1 through the unchanged `tests/helpers/d1.ts`, applies the actual migration chain and disposes it. Nothing uses the application's `.wrangler` state. The supplemental test reads results from the first test; rerun it separately after the first test if running files in parallel.

Machine had eight logical CPUs and load averages4.28,3.39,3.49 at start. Concurrent desktop activity was present. A process sample during the run showed workerd61.9% CPU and Vitest49.6%; this does not isolate SQL, Node serialization and loopback IPC. Consequently elapsed times below describe this local probe only. They do not establish a production speedup. Worker CPU cannot be inferred from Node wall time. No release HTTP render or network/provider latency is included.

## Search at 100,000 products and 10,000 orders

Five samples per query at each of10,5,000,100,000 products; query order alternates. All90 initial samples completed, returned nonempty correct results and had no errors. Each product has one variant, identical title token and a tied timestamp. This intentionally exposes broad-match sorting and tie behavior, but does not represent a typical mixed catalog or many variants per product.

| Query | Median local ms | Range ms | D1 rows read | Query plan |
|---|---:|---:|---:|---|
| Exact SKU |2.42|2.17–2.75|1|SEARCH variants_sku_unique |
| Prefix LIKE, early match |2.76|2.37–3.10|20|SCAN variants_sku_unique |
| Explicit SKU range |2.64|2.50–10.71|20|SEARCH variants_sku_unique range |
| Broad product FTS + sort |12.13|11.70–21.31|300,000|FTS, primary-key joins, temporary sort |
| Exact order number |2.57|2.37–2.99|1|SEARCH orders_number_unique |
| Order email + tie sort |2.55|2.46–3.60|21|SEARCH orders_email_idx, temporary sort |

The supplemental adversarial prefix test searches near the end of100k SKUs. `LIKE 'SKU-0999%' LIMIT20` reads99,920 rows; an explicit binary range reads20. Therefore, the early prefix sample is not evidence that LIKE is bounded. Choose an explicit indexed range after defining SKU normalization/case semantics. The demonstrated range is for ASCII fixture SKUs, not a complete Unicode prefix algorithm.

The supplemental production-shaped FTS query uses the current public search status predicate and `created_at DESC,id DESC LIMIT21`. It also reads300,000 rows for a term matching all100k products. FTS being present and a page being capped do not establish bounded work. Do not claim the admin's future broad search is cheap without selecting a result-order contract and measuring its worst case. Exact SKU and selective terms should remain distinct query paths. Stable id tie breakers are included in proposed sorted queries; multi-page/no-duplicate pagination under concurrent writes has not been exercised in this probe.

## Fewer commits reduce real publisher and purge work

Use the unchanged publisher on a30-product catalog. Build and drain it first. Alternate five runs per mode. Sequential mode commits three intermediate versions of one product and fully publishes/purges each. Reviewed mode commits one final version once. Both update content fields, not inventory. KV is an instrumented in-memory binding; D1 and publisher SQL are real workerd SQLite. Date is advanced to satisfy existing paced delivery windows. This cannot measure real publication wall-clock delay.

| Metric per completed task | Three sequential saves | One reviewed submission |
|---|---:|---:|
| Committed content versions |3|1|
| Bounded publisher units invoked |15|5|
| Publisher budget D1 statements |360|120|
| KV get calls |21|7|
| KV put calls |15|5|
| KV delete calls |0|0|
| Purge callback calls |3|1|
| Purged tags |6|2|
| Local median elapsed ms |2478.35|779.37|
| Local elapsed range ms |1840.79–3688.43|616.23–846.33|

All five runs per mode had the same operation counts, no errors and `processed_revision=target_revision` for the edited product. KV keys prove product documents, slug pointers, listing pages, directories and current pointers were written. Purge callback counts are executions of the real durable invalidation drain against a successful fake endpoint, not Cloudflare API calls. Publisher budget statement counts exclude the source edit, fixture setup and invalidation-drain SQL. Queue messages are unavailable because the probe invokes publisher units directly rather than Worker queue deliveries. Five units does not mean five queue messages; the production handler may execute several units per delivery.

The experiment proves less work when intermediate versions would otherwise reach publication. Existing coalescing may already avoid some intermediate work if edits arrive faster than the publisher. Therefore this is not a universal66.7% production saving. It does not show any additional backend saving from IndexedDB versus ordinary in-memory editing with one reviewed submission.

## Checkout coexistence probe

Use unchanged `createPendingOrder` plus the existing held-order reservation helper, with real D1 and ledger checks. Run five alternating baseline/admin pairs at concurrency1,5,10. Admin mode simultaneously executes10 staff-shaped jobs, each reading current Orders and Products lists plus the sales report. Fixture has10,000 paid historical orders and one stocked product. Currency configuration and reservation constraints remain intact. This is a database/domain probe, not the full HTTP checkout path, authorization, admission DO, Stripe or recovery latency.

| Concurrent domain checkouts | Baseline median batch p95 ms | With10 admin jobs | Change | Proposed10% gate |
|---|---:|---:|---:|---|
|1|38.89|210.04|+440%|Fails local proxy |
|5|155.73|288.00|+85%|Fails local proxy |
|10|401.15|425.21|+6%|Within threshold in noisy local proxy only |

Each batch p95 is its maximum at these small sample sizes. Table summarizes medians of five batch maxima, not a production p95 estimate. Total160 checkouts completed, no checkout/admin errors, and ledger counters reconciled after every batch. Results show that concurrent broad admin reads can interfere with checkout. They do not establish sustainable throughput or certify a deployment. The10-way baseline range275.85–525.36ms overlaps the admin range399.94–655.24ms, so no stable10-way regression conclusion is justified. Two local scenarios clearly miss the proposed gate and it remains closed.

A proper production-like acceptance run still needs HTTP checkout on an isolated deployed environment, enough successful samples for meaningful p95,10 authenticated admin sessions at a declared request cadence, warm/cold storefront cases, imports and publication concurrently, provider stubbing or test mode, and Worker/D1/DO telemetry. Do not infer that an admission rejection is a completed checkout.

## Evidence gaps

- Warm/cold HTTP storefront, real browser caching and geographic edge misses are outside this domain harness.
- Worker requests/CPU, DO duration, physical queue messages and production cache purges are unavailable; no zeros are substituted.
- Full100k publication bootstrap, multiple variants per product, large media, collection rules, import coexecution and long-run retries are not represented by the30-product publication fixture.
- Query read/write metadata is captured for direct query probes and source bulk edits. Publisher D1 rows and the checkout's full rows-read/write footprint are not collected.
- No capacity or monthly-bill claim is made. The separate monthly worksheet is sensitivity analysis with explicit assumptions.

## Harness verification notes

The first supplemental run failed because D1 `meta.changes` counted trigger effects as well as direct updates. The harness now verifies affected domain rows with a separate count instead of treating `meta.changes` as the number of variants. This was an audit assertion error, not a newly observed application defect. The failing run was not included as a successful sample.

## Supplemental bulk publication evidence

The supplemental suite passed after the audit assertion fix. Five alternating repetitions per bulk scenario use a30-product catalog with25 variants on one product. A second scenario updates20 distinct products in a single SQL statement. Domain rows are counted explicitly because trigger writes make `meta.changes` larger than the edited record count. Each trial fully drains existing publisher work and verifies zero source revision lag.

| Completed bulk edit | Publisher units | Publisher D1 budget statements | KV puts | Purge calls | Local median elapsed ms | Range ms |
|---|---:|---:|---:|---:|---:|---:|
|25 variants on one product|5|120|5|1|779.22|574.92–867.15|
|20 distinct products|81|2134|100|1|19712.21|12985.98–26826.20|

All five repetitions have identical operation counts and no errors. Existing work capture coalesces25 variant edits into a single product publication. Twenty product changes still require20 product publications and their listing updates, even though the source edit and purge drain are each a single call. This is direct evidence that UI batch size and purge count are insufficient cost proxies. Unit invocation counts are not physical queue message counts. These are small-catalog operation counts with a fake KV endpoint, not100k publication latency or a reason to replace the existing publisher.

No new queue or cache is justified by these observations. Keep per-record reviewed publication, use explicit bounded bulk operations, and measure rule/media fanout separately before selecting a high-volume bulk limit.

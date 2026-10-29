# Monthly resource budget worksheet

This is a projection worksheet, not a measured Cloudflare bill. Target 100,000 products, 1 million visits, 10,000 orders and 10 staff. Three page views per visit gives 3 million monthly page views. API calls, media delivery, retries, admin refreshes and background work are additional. Account-wide allowances may already be shared with other applications.

Rates checked against official Cloudflare documentation on 2026-10-25. Workers Standard baseline is $5. Use actual metered dimensions, not one “request” counter, to calculate the total.

| Dimension | Included on paid plan | Overage | Workload input still needed |
|---|---:|---:|---|
| Workers incoming requests | 10m/month | $0.30/m | Page views + APIs + media through Worker + webhooks + admin; static assets differ |
| Workers CPU | 30m ms/month | $0.02/m ms | Measured gateway, render, checkout, queue and scheduled CPU |
| D1 reads | 25bn rows/month | $0.001/m rows | Actual query rows × operation frequency, including FTS fanout |
| D1 writes | 50m rows/month | $1/m rows | Commerce, indexes, FTS, work capture, publishing, audit and recovery writes |
| D1 storage | 5 GB | $0.75/GB-month | Full catalog, orders, indexes and publication mirrors |
| KV reads | 10m keys/month | $0.50/m | Keys per uncached render × actual geographic miss rate |
| KV writes, deletes, lists | 1m each/month | $5/m each | Publication versions, repairs and reclamation |
| KV storage | 1 GB | $0.50/GB-month | Active and retained immutable documents |
| R2 standard storage | 10 GB-month | $0.015/GB-month | Photos, derivatives and retention |
| R2 Class A | 1m/month | $4.50/m | Uploads, metadata changes and object listing |
| R2 Class B | 10m/month | $0.36/m | Actual R2 reads after public delivery caches |
| Queue operations | 1m/month | $0.40/m | Write + read + delete per ≤64KB delivery; retries add reads |
| Durable Object requests | 1m/month | $0.15/m | Admission RPC, reconnects, broadcasts and incoming WS billing |
| Durable Object duration | 400k GB-s/month | $12.50/m GB-s | Actual active time; hibernation eligibility matters |
| DO SQLite storage | 5 GB-month | $0.20/GB-month | Existing admission/realtime state |
| DO SQLite rows | 25bn reads,50m writes/month | $0.001/m reads,$1/m writes | RPC and alarm state operations |
| Workers Logs | 20m events/month | $0.60/m | Actual event count at current full sampling; pricing changes Dec1,2026 |
| Cache purge | Existing token bucket | Capacity constraint | Pending tags, calls and time to drain; not assumed free capacity |

## Sensitivity rather than a fabricated bill

Run `node .audit/gate0/resources/cost-sheet.mjs`. The accompanying JSON varies page depth, cache miss rate and mean CPU independently. Five KV keys per miss and three R2 reads per page are explicit illustrative inputs, not measured facts.

At 3m page views, mean request CPU of 1,5,15ms consumes 3m,15m,45m CPU-ms. The last case adds $0.30 of Worker CPU before other work. At five KV keys per uncached page, 1%,10%,100% misses yield 150k,1.5m,15m KV reads; the last case adds $2.50. These figures do not account for APIs, publication or background work.

At 6m page views and 100% misses, the same KV assumption yields 30m reads and $10 KV-read overage. Mean CPU15ms yields90m ms and $1.20 CPU overage. Three actual R2 reads per view yields18m reads and $2.88 ClassB overage. The media path may instead serve public cached objects, so use telemetry before adopting this assumption.

Illustrative media storage of 100k products ×3 photos ×250k bytes is75GB decimal. If no other retained media exists, storage above10GB is65GB and costs approximately$0.975/month. Derivatives, originals, abandoned uploads and large images alter this substantially. This is not a measured library size.

The measured publication experiment produces5 KV puts and1 purge for one final content commit on a30-product fixture. If 10k comparable edits occur per month, that portion would be50k puts and10k purge calls. Three separately published intermediate saves would be150k puts and30k purges. Do not extrapolate this coefficient to100k products, rule collections, multi-product updates or media fanout without measuring them.

## Operational budget decision

Keep $5 as the baseline and approve growth charges only against completed work. Aim to keep ordinary catalog pages off D1, exact admin lookup at bounded indexed reads, and repeated edits behind one explicit commit. Do not weaken checkout validation to save reads. Cost alerts should follow whichever metered dimension approaches its allowance; this audit does not install alerts or change settings.

No complete monthly total is claimed. Deployed CPU, geographic hit ratios, actual media storage, DO duration, API frequency, edit frequency, recovery volume and queue retry telemetry remain unavailable. A low Worker request bill does not certify checkout capacity.

## Sources

- [Workers, KV, R2 and Logs pricing](https://developers.cloudflare.com/workers/platform/pricing/).
- [D1 pricing and index write amplification](https://developers.cloudflare.com/d1/platform/pricing/).
- [Queue operations and retries](https://developers.cloudflare.com/queues/platform/pricing/).
- [Durable Object compute and storage](https://developers.cloudflare.com/durable-objects/platform/pricing/).

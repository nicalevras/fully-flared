# Scaling and verification boundaries

## Read and publication paths

D1 is authoritative. KV holds content-addressed pages: 24 product cards on
home, 48 in collections, 48 collection summaries on discovery, and 50 post
summaries in the journal. Product, collection metadata and editorial documents
are immutable, with small mutable pointers. Layout holds at most eight
navigation collections, four collection teasers and three post previews.
Stock is never in catalog KV. Availability uses its separate short cache below.
Readers validate schema, requested identity and complete artifact hashes. A KV
miss uses the exact pinned D1 mirror, not a newer publication or live source.
A missing reference resolves committed D1 history once per request. A missing
known artifact in both stores fails visibly rather than inventing a 404 or
silently exposing a draft. Search runs
against the D1 `products_fts` index and fetches only matching cards; it
never walks listing pages.

Change capture is transactional: D1 triggers (migration 0004) write
`catalog_work` rows with each catalog edit, and the publisher drains
that queue incrementally. A single product edit republishes only the
affected keys; a pass with no changes writes
nothing. A new listing generation activates only after every page is
durably written, so readers never mix generations. Product documents
are rewritten only when their product changes.

Earlier capacity numbers are historical. The latest isolated Round-2 gate
built 100,000 products in 2,911 actual queue invocations, but failed its
single-edit write ceiling before the activation repair. It is not a current
acceptance pass. Full ordinary and isolated 100k reruns remain deferred at the
user's request; Phase-3 focused/HTTP evidence is in REMEDIATION. Local counts
do not establish deployed capacity. The old single-snapshot path (one `catalog:current`
value, the `catalog_publication` table) is removed; migration 0005
dropped the table. Version state is deliberately kept out of the public
store settings read model.

Realtime fan-out is best-effort after successful publication.

Request-local AsyncLocalStorage caches promises for nested, sequential and
concurrent loaders. It ends with that request; no cross-request layout TTL can
pin a later shopper to an earlier publication. Each listing's reference also
pins its counts, featured product, page directory and collection SEO metadata.
Page keys include the full serialized artifact hash, not the build generation,
so A→B→A reuse remains valid. Publication-only metadata stays in the reference.
Collection and journal index builds scan with persisted keyset cursors and
restart when their captured source revision changes. Discovery never silently
truncates; the directory preparation currently rejects more than 4,500 index
pages explicitly. Upgrade that bounded directory stage if editorial/collection
volume exceeds 216,000 collections or 225,000 posts.

## HTML caching

Anonymous public HTML is cached with Workers Cache through the
`PublicStorefront` entrypoint: the gateway classifies requests as
public or private, and only public GET pages are stored, under a
normalized 60-second cache policy. For classified public HTML, the gateway
strips cookies and authorization before rendering; those private headers cannot
personalize a shared response. Private routes, server-function endpoints and
cookie-setting responses bypass storage and carry no-store headers.
Cart counts are no longer rendered into public SSR HTML (the
badge hydrates from a private server function), so a cached page never
freezes one shopper's cart.

Invalidation is scoped: catalog changes record `Cache-Tag` targets and
the purges execute inside the cache-owning entrypoint, because Workers
Cache is per-entrypoint. Local tests verify the classification,
headers and purge routing. Deployed cache-hit behavior and purge
propagation are **not** established locally; they remain a deployment
acceptance item on a supported custom domain or route (workers.dev and
local tests cannot prove them). Cache is per location.

## Availability reads

Each listing batches its visible product IDs into `getAvailabilityFn`, a GET
TanStack Start server function with the shared validator/function boundary
(up to 50 distinct IDs per request). A product page uses `mode=product` for its
active variants together, so changing options needs no request. Availability is
requested once on page load/navigation only. Cart additions do not refresh it. There
is no polling, focus refresh or automatic retry. An untouched page can retain an
old result indefinitely. Unknown/failed reads leave purchasing enabled within
product status and configured quantity limits, without invented stock counts;
confirmed responses update badges and controls. Cached product JSON-LD omits
stock availability.

The server helper performs one parameterized, indexed D1 query for the batch of
missing products. Internal Workers Cache API entries are per product and mode,
with `Cache-Control: public, max-age=5` and an explicit expiration check. Overlapping
listings reuse entries, and overlapping in-flight reads coalesce within an isolate.
Only the internal response copy is cacheable; browser/API responses are `no-store`.
Errors are never cached. Missing, ineffective or failed cache storage falls back
to D1, with fixed structured events for failures. Workers Paid is the deployment
target; a cold 50-product request can make 50 Cache API matches and 50 puts,
within its 1,000-call quota. These are not global cache entries: reuse is within
a Cloudflare data center. Local tests cannot prove deployed reuse, and workers.dev
must remain functional when storage is ineffective. No hostname gate is used.

KV cannot provide this cache: its read `cacheTtl` minimum is 30 seconds and its
values are eventually consistent. Five seconds limits cache age when a request
occurs, not browser display age. Cart additions/increases validate product status
and store quantity limits without checking stock or reserving it; decreases and
removals remain possible. Checkout alone enforces stock with atomic reservations. Sales, releases and restocks leave
catalog publication keys and HTML cache versions unchanged.

See [Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/),
[Cache API example](https://developers.cloudflare.com/workers/examples/cache-api/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[KV reads](https://developers.cloudflare.com/kv/api/read-key-value-pairs/) and
[KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

## Write path

For new manual-capture attempts, D1 creates an unpaid order without holds.
Verified authorization precedes the atomic inventory/coupon allocation; capture
precedes the guarded paid transition. Legacy attempts retain their recorded
policy. D1 batches make allocation and paid transitions atomic. Every dependent
paid/canceled mutation references the winning transition identity. Receipt and
refund notification records are inserted transactionally with deterministic
identities. Refund operations reserve balance while pending or uncertain;
only successful totals determine refund state. Creation retries use stable
Stripe keys, provider reconciliation, backoff and attempt caps.

Default Stripe Sessions last 32 minutes; checkout_session_minutes allows
32–1440. Session expiry is separate from post-authorization allocation. Uncertain
capture allocations cannot expire into available stock. Provider retrieval and
durable cancellation/refund recovery resolve them. Configured cart/order/checkouts/refund limits are enforced
from D1 with defaults when rows are missing; limit settings have matching Zod
and SQL bounds. The refund creation retry cutoff remains fixed at 23 hours to
avoid Stripe's 24-hour idempotency-key pruning window. Backorders
may produce negative on-hand counts deliberately; normal variants may not.
Inventory history is append-only and reconciles with counters.

Cart additions use atomic SQL increments, so concurrent additions do not overwrite
each other. Active product/variant checks and configured quantity/line limits
remain in place. Adding to cart neither checks nor reserves stock.

Checkout starts pass through `CheckoutAdmissionDO` (Phase 5): a
token-bucket plus lease permits bound aggregate checkout initiation, so
thousands of distinct shoppers cannot stampede the provider. Defaults
are conservative starting budgets (5 starts/second, burst 10, at most
10 active permits), editable by admins; they are not measured capacity.
Denied starts create no intent, order or reservation and return
`429 CHECKOUT_BUSY` with `Retry-After`; an unreachable controller
returns `503 CHECKOUT_UNAVAILABLE` rather than failing open. Replays of
an existing intent consume no permit. Locally, a burst of 1,000
simultaneous arrivals admitted 211 exactly-once completions and
cleanly rejected the rest; deployed throughput targets (for example 25
initiations/second) are not established by local tests and remain a
deployment acceptance item.

Captures, cancels, refunds and reconciliation for shoppers who already
authorized use a separate `settle` controller with the same configured
numbers, so a rush of new checkouts cannot starve them; size the
defaults knowing each lane gets the full budget.

## Queues, email and recovery

Queues are separated by failure mode (Phase 5): `JOBS` carries financial
work (webhook processing, checkout initiation/uncertainty, refunds,
reconciliation), `NOTIFICATIONS` carries email sends, and
`CATALOG_JOBS` carries catalog publication and cache invalidation; all
three dead-letter into the shared `store-jobs-dlq`. Realtime broadcasts
are direct Durable Object calls after durable transitions, never queued.
The webhook route never processes inline: it durably records the inbox
row, enqueues, and acknowledges; the cron sweep owns recovery when the
queue is unavailable, replays due dead-lettered rows on a fixed 6-hour
cycle, and owner/admin staff can replay a quarantined event from the
admin dashboard under its original event identity.
Webhook and email processing honor durable retry times and caps in both queue and cron
paths. Poison payloads and dead letters produce deduplicated operational
alerts. Alerts use a configured recipient or verified owners, never the sender
address. Legacy sending rows receive a migration-time claim timestamp.

Receipt, refund, shipment and operational-alert transactions enqueue their
deterministic outbox IDs immediately after commit. A failed enqueue leaves the
durable row available to the existing cron recovery path. A transaction rollback
cannot enqueue its notification. Existing delivery claims, retry caps and timing
remain in force.

Reconciliation keeps its existing cron and queues, with named D1 cursors
(pre-squash history; the cursor schema now lives in the 0000 baseline); each leg advances only after successful checks, with compare-and-swap
updates preventing a concurrent older pass from rewinding progress. Each pass
checks at most 100 Stripe sessions, 25 local orders, 25 local refunds and 50 source
records for each stock/refund-total invariant. Due refund operations and stuck
refund alerts each inspect at most 25 rows. Batch lookups replace per-session
order queries. Completed sweeps wrap around; healthy early records cannot starve
older records indefinitely. Confirmed provider 404s are distinct from outages,
which fail that leg without advancing its cursor.

Historical combined-cron evidence measured 705 statements and 28 batches in
one fixture. It does not describe the current execution path: cron dispatches
bounded continuations on existing queues. Financial safety runs every 15 minutes,
privacy hourly, and historical reconciliation, retention, optional reminders,
replica verification and reclamation daily. Each run preserves its cutoff and
cursor until coverage completes; completion must be measured from durable
progress, not scheduler success. This new path still needs regression evidence.
Cloudflare's official pages currently disagree about the applicable paid-worker
budget: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) says
1,000 queries per invocation, while [Workers subrequest limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
lists a 10,000 default on Paid, configurable up to ten million. The
[subrequest change](https://developers.cloudflare.com/changelog/2026-02-11-subrequests-limit/)
does not resolve D1's separate published figure. Treat 1,000 as the conservative
planning budget until Cloudflare clarifies it. Local Miniflare tests do not
reproduce either deployed enforcement threshold. No new queue resource is
introduced. Durable maintenance run claims/progress use the existing JOBS and
CATALOG_JOBS consumers, with bounded pages and recovery of missed continuations.

Outbox insertion can be once-only. External email transport can redeliver after
an ambiguous send or crashed process; it is not exactly-once transport. A
failed realtime broadcast does not cause a successful publication to retry.
A real workerd test verifies subscriptions across Durable Object eviction.

## Backups and release gates

Catalog Round-2 repair uses one bounded queue unit per invocation and counts
native D1 statements, including fences and handler follow-up. Large source
builds capture per-entity work revisions and acknowledge them in bounded pages;
edits during a build remain queued. Replica verification uses persisted indexed
cursors and yields to source edits. A completed sweep waits fifteen minutes
before another routine sweep; a detected missing main reference starts recovery
without that wait. Repair restores durable committed artifacts. Rebuilding from
source is a separate explicit operation, not ordinary KV-loss recovery.

Incremental card edits prepare immutable pages/directories first and persist one
prepared publication in a build-listing row. A later fenced delivery activates
it with its retry marker and invalidation; the existing reference outbox handles
delivery. Membership changes use scoped resumable builds. These boundaries keep
artifact preparation and the transactional publication commit from exhausting
one invocation's statement budget.

Local queue tests establish binding-operation bounds, not deployed capacity or
KV propagation time. Repair rejects artifacts over 2 MiB with an error instead
of truncating them; that conservative per-artifact bound leaves space within the
8 MiB invocation materialization budget. Larger artifacts require measured
changes to the bounded publisher/repair contract.

There is no automated backup export. Recovery is D1 Time Travel only (30
days on Paid, 7 days on Free, always on, in-place restore undoable via the
returned bookmark; see "Backups and recovery" in the root README). Off-site
per-table `wrangler d1 export` copies are records, not a restore mechanism:
a whole-database export cannot handle the `products_fts` virtual table, and
exported rows cannot be imported into a migrated database. Store size does
not affect recovery: Time Travel has no row or SQL-size cap of ours to hit.

Local tests cover races, a realistic catalog fixture, restore, HTTP boundaries
and private-cache exclusion. Actual Stripe subscriptions/charges, cache hits
on a supported hostname, 200 req/s at p95 below 300 ms, checkout burst targets,
and the deployed reconciliation soak remain unverified. Local load numbers
must not be presented as deployed capacity.

## Catalog reclamation (0012)

The existing publisher lease also fences durable garbage-collection batches.
GC runs only when publication is idle and no nonterminal build exists, including
paused work and capture checkpoints. A catalog reference, product document
revision or editorial pointer change advances the GC source revision. A changed
revision restarts marking; each deletion rechecks that revision and the lease
before claiming it and again before deleting its D1 mirror.

Inventory, root enumeration, mark expansion and sweeping use persisted keyset
cursors and pages of at most 100 rows. A directory expansion visits one bounded
128-entry node. Shared content-addressed nodes are marked once per sweep. The
work uses the same 40-statement/800-KV/900-combined/5,000-row/8-MiB/90-bind
invocation limits as publication; KV list operations count too. KV enumeration
uses `list_complete`, including empty pages with a continuation cursor.

Current references and their reachable pages/directories/documents remain roots.
Superseded reference history remains a root for seven days. After the last
retained reference disappears, the first unreferenced observation starts another
seven-day artifact grace period; creation age never authorizes deletion. This is
conservative: a superseded publication can retain artifacts for at least fourteen
days, plus sweep delay. KV-only interrupted writes receive the same grace.
Terminal-build staging rows and expired history are pruned in bounded pages.

KV deletion precedes mirror deletion. Failure retains the artifact and durable
five-minute retry time. Re-reference clears retirement/retry state. A lost fence
or publication racing the external delete preserves the mirror; exact-reader
fallback and repair recover any missing KV value. A fence cannot revoke an
already-started KV call, so a temporary KV miss remains possible. Missing or
invalid referenced directory mirrors abort marking safely. Continuous edits or
unfinished builds can defer reclamation; monitor the checkpoint rather than
claiming a fixed completion SLA. Idle sweeps run daily; failed deletes wake sooner.

Retention/IP scrubbing processes at most 1,000 rows per category per cron pass,
with stable indexed ordering. Only released reservations expire; committed holds,
orders, refunds and inventory-ledger history are preserved. The six-hour dead
webhook retry policy and permission-guarded, audited staff replay are unchanged.

The focused Phase-4 evidence is in REMEDIATION. The 100k gate was not rerun for
this change, and no deployed reclamation throughput or cache behavior is claimed.

Documentation checked through Context7:
[KV listing](https://developers.cloudflare.com/kv/api/list-keys/) and
[KV deletion](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/).
These runtime semantics are independent of the installed Wrangler 4.151.1 CLI.

## Current delivery/operations implementation, not measured capacity

Catalog writes wake the bounded publisher from transactional work revisions.
The 15-minute safety tick only checks indexed due/interrupted work and due posts.
Changed references receive prompt delayed verification; the full replica sweep
and GC have separate daily run progress. Reference invalidations become purgeable
only after delivery; failures remain durable. Listing cards omit full descriptions
and SEO bodies. Serialized KV artifacts are limited to 1.5 MiB before production
writes, within the shared 8 MiB invocation budget.

Route-specific semantic parameters normalize public cache keys. Cart badge
hydration reads only the nonsecret count cookie; authoritative cart mutations
share their result to avoid immediate duplicate reads. Availability remains
page-load-only with its five-second internal cache, and public HTML keeps its
existing TTL/private boundary. Optional public media advertises only ready
immutable variants; editorial and SEO URLs use the same published metadata.

A build reports done only after the references it committed reach KV. KV allows
one write per second per key, so a reference written under a second ago stays
pending and the unit retries after two seconds. Five minutes of backoff after a
failed put does not hold the build open. `verifyChangedReferences` logs
`catalog_ref_mismatch` when KV disagrees with D1; any steady stream of it in a
soak means the pacing or the propagation assumption is wrong.

The 100k gate (`npm run test:scale`, `CATALOG_SCALE=1`) is a local harness and
needs a quiet machine. Miniflare reaches D1 over a pooled loopback socket, and
workerd closes a connection idle for 5 seconds. A test process that blocks its
event loop that long cannot run undici's 1 second idle timer, so the next calls
meet closed sockets. The harness redelivers each such call and logs every retry
(`test_d1_transport_retry`) until a run has spent 20 retries. Production D1 does
not use this path.

FF-16/20/21/23/24 remain measurement gates: static asset billed invocations,
availability cache overhead, logs, D1/KV/media capacity including history, and
regional cache hit/latency/purge freshness. Neither compiler success nor local
fixtures establish deployed throughput, propagation, billing or a production soak.

## Checkout hardening follow-up: evidence still pending

Recovery families now use independent records in the existing maintenance table
and queue. Historical provider reconciliation can resume between records and uses
a 30-second delivery deadline (10 seconds per call, no new call below 5 seconds
remaining). This bounds initiation of provider work; it does not prove deployed
throughput or guarantee provider resolution during an outage.

Public media publication handles one immutable object per maintenance delivery.
Upload claims do not dirty catalog work. Public deletion includes recorded pending
uploads and prior destinations and requires both object deletion and cache purge.
Historical untracked orphan objects remain unverified. See the
[checkpoint ledger](archive/CHECKOUT-HARDENING.md). These changes have not run the
ordinary suite, isolated 100k gate or deployed measurements.

## Conditional recovery watchdog (2026-10-23; verification pending)

The 15-minute safety watchdog now checks shared business-record eligibility and
unfinished maintenance runs before enqueueing recovery. It no longer starts seven
families unconditionally. The intended idle acceptance case is a fully initialized
store with no due work, no unfinished runs and no pending catalog invalidations:
zero new recovery runs and zero Queue sends. This has not yet been measured.

Recovery remains independent per family using the existing queues and D1 records.
Outbox recovery runs on NOTIFICATIONS, queues at most 25 rows per delivery, and
persists a created_at/id cursor for a fixed coverage cutoff. It never loops back
while already queued mail remains pending. The consumer retains existing send
claims, retry caps and ten-minute stale-send recovery. Delivery is not exactly once.

Prepared migration 0017 adds retry/age/attempt/claim indexes. EXPLAIN QUERY PLAN,
rows-read measurements, focused recovery tests, clean CI/build verification and
local migration application remain pending. See the
[checkpoint ledger](archive/RECOVERY-WATCHDOG.md). No savings or deployed capacity
claim follows from these source changes alone.

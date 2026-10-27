# Decision Log

Every expensive-to-reverse choice is recorded here before code assumes it.
Status: `approved` (locked), `pending` (awaiting owner approval — no dependent
code may be written), `revisit` (locked with a named trigger to reopen).

## Approved

| #   | Decision                                                                                                                                                                                                                 | Why                                                                                                                                                     | Alternatives rejected                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Self-hosted, single-store per deployment. Open-source repo; each installer deploys to their own Cloudflare Workers Paid account.                                                                                         | Owner owns data, keys, and account. No SaaS, no multi-tenancy.                                                                                          | Hosted SaaS; multi-tenant single deployment.                                                                                              |
| D2  | TanStack Start serves storefront, blog, customer account, and admin in one Worker; SSR by default. There is no fallback framework.                                                                                       | One React codebase; reuses upstream admin's TanStack Table/Query/Router components; crawlers get rendered HTML. Tracer gate passed 2026-10-17.          | Astro storefront + separate admin (rejected outright — splits auth/components, and no fallback is carried); Next.js (not Workers-native). |
| D3  | D1 is the only durable system of record. No checkout coordinator Durable Object.                                                                                                                                         | `batch()` is transactional and D1 serialises writes; a coordinator is a second lock in front of a lock.                                                 | Merchant's single-DO SQLite monolith with SQL-over-RPC; coordinator DO.                                                                   |
| D4  | Stripe-first payments behind a `PaymentProvider` interface (`createCheckout`, `verifyWebhook`, `refund`). Stripe Checkout hosts the payment page.                                                                        | PCI scope stays with Stripe; second provider becomes additive.                                                                                          | Hand-rolled card forms; multi-provider at launch.                                                                                         |
| D5  | Email via Cloudflare Email Service (`send_email` binding). Transactional only.                                                                                                                                           | No third-party provider or API keys; requires Workers Paid, which is already the target plan. 3,000/mo included, then $0.35/1k.                         | External ESP as default; marketing/bulk sending in scope.                                                                                 |
| D6  | Base currency is an admin setting, default USD on fresh install; locks after first live order.                                                                                                                           | Store identity is installer data, never code.                                                                                                           | Hardcoded currency; multi-currency in v1.                                                                                                 |
| D7  | Shipping zones (country groups) with named rates per zone are admin settings.                                                                                                                                            | Mirrors Shopify's model; installer data, changeable post-launch.                                                                                        | Developer-supplied shipping config.                                                                                                       |
| D8  | Store name, domain, logo, meta/SEO defaults are admin settings in D1 with neutral placeholders. Canonical base URL is a setting; domain read from request host.                                                          | An OSS codebase contains zero store identity.                                                                                                           | Hardcoding any operator's store.                                                                                                          |
| D9  | Real-time is admin-only, via one hibernatable-WebSocket Durable Object fed from the outbox. Shoppers get short-TTL cached stock labels.                                                                                  | Sockets for every shopper would pin one DO awake and become the largest bill.                                                                           | Merchant's unrouted in-memory WebSocket design; shopper sockets.                                                                          |
| D10 | Stock held 30 minutes at checkout, aligned to the Stripe Checkout Session `expires_at` set to the same instant.                                                                                                          | Stripe's minimum session window is 30 minutes; expiry event releases the hold.                                                                          | 24-hour default sessions with leaked holds (upstream behaviour).                                                                          |
| D11 | Admin bootstrap via the `OWNER_EMAIL` Worker variable (comma-separated). Accounts created with a listed email get the `owner` role at sign-up; all other sign-ups are customers. Staff below owner are created in Admin. | Installer-set configuration, no SQL edits in the setup flow; variable can be cleared after bootstrapping. SQL role update kept only as a recovery path. | Manual `UPDATE user SET role = 'owner'` as the documented setup step (replaced).                                                          |

## Approved by owner on `go` (2026-10-17, execution directive)

| #   | Decision                    | Choice                                                              | Why                                                                                                                                                                                                                                                                                             |
| --- | --------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Data-access library over D1 | **Drizzle ORM** (`drizzle-orm/d1`, drizzle-kit migrations)          | Official Better Auth D1 adapter targets Drizzle; type-safe schema doubles as the migration source; transactional `batch()` remains available on the underlying D1 handle for the reservation critical section; SQL stays inspectable, exit cost is a query-layer rewrite, not a data migration. |
| P2  | Auth for customers + staff  | **Better Auth** (one instance, one user table, role-differentiated) | Official TanStack Start integration and D1 adapter; magic-link/OTP and 2FA plugins; credentials/session security is not hand-rolled. Staff sign-up disabled; staff created by owners in admin.                                                                                                  |
| P3  | Blog editor component       | **TipTap** (React, headless)                                        | Client-only editor (no Workers runtime constraints), image node support for R2 media insertion, MIT-licensed core, content stored as HTML + JSON in D1 so the editor is replaceable without a content migration.                                                                                |

| D12 | CSP keeps `script-src 'unsafe-inline'` (documented exception). | TanStack Start SSR emits inline hydration scripts and the SEO JSON-LD head scripts are inline by design; removing `unsafe-inline` without a nonce pipeline breaks hydration. The policy stays strict everywhere else (`object-src 'none'`, `frame-ancestors 'none'`, no `unsafe-eval`). Revisit when Start supports per-response script nonces end-to-end. |

## Record correction: local D1 and migration 0009 (2026-10-18, rebuild completed)

Disclosure, stated plainly: the original migration `0009_phase_c_baseline.sql`
was applied to the owner's local D1 on 2026-10-18 at 09:11 ET. That edition
contained `DROP TABLE orders`; with foreign keys enforced, the drop cascaded
and deleted the line items of all 43 orders that existed locally at that
time. The migration was later rewritten into a data-safe edition under the
same filename. Because D1 records applied migrations by name, the rewritten
0009 will never run on that local database: the local DB still carries the
old CHECK schema and is missing the 0007 triggers on orders, refunds,
reservations, outbox and the ledger, plus `reservations_qty_guard_insert`.
Local data affected by this is development data only; no production or
remote database ever received the unsafe edition.

Standing rule (from this incident): an applied migration is never rewritten.
Fixes ship as a new numbered migration, even locally.

Completed local rebuild (2026-10-18, authorized by the owner): stopped the
workspace Vite dev/preview processes, copied all local Wrangler state (including
SQLite WAL/SHM) to the external `remediation-20261018-122318` backup directory,
and verified all 46 files by SHA-256. Old D1 and KV directories were moved beside
that backup after checking their absolute paths. Local R2 media was preserved.
A clean D1 received migrations 0000–0015 and the seed; forward migration 0016
added refund retry metadata and cart guards. No remote database was changed.
The historical damaged local state described above is retired.

Forward migrations 0014–0016 repair physical guards and add order/refund,
shipping and publication metadata. Applied files were not edited. Phantom
Drizzle CHECK declarations were removed from the current schema. Isolated
generation proposed parent-table reconstruction, which was rejected; matching
snapshots accompany explicit ALTER/trigger repairs instead. Drift checks report
no further schema diff. Populated upgrades preserve commerce relationships.
A real Wrangler whole-file backup import and subsequent migration are tested.
See `docs/archive/REMEDIATION.md` for final commands and service restart evidence.

## Round-two limits and deployment update

Round-two update (2026-10-18): migration `0017_store_limits.sql` seeds nine
bounded admin settings and replaces/adds triggers only. It does not rebuild or
alter tables. Missing setting rows preserve the previous defaults. The local
upgrade followed a complete 54-file SHA-256-verified Wrangler state copy to
`C:\Users\nicka\AppData\Local\store-backups\round2-20261018-141704\state`;
remote databases were untouched. Hold duration is now configurable, retaining
the 42-minute default and ten-minute session buffer. `OWNER_EMAIL` must remain
configured for deployment; D11's earlier suggestion to clear it is superseded.
Public signup never promotes an owner: the explicit bootstrap performs that
operation. See the round-two record in `docs/archive/REMEDIATION.md` for current evidence.

## Revisit triggers

- D3 reopens (storage move behind the data-access layer) if a single store sustains write-queue saturation in load tests, or approaches 50% of D1's 10 GB cap after archival.
- D4 reopens when a second payment provider is scheduled; the interface must gain its second implementation then, not later.

## Inventory/catalog separation (2026-10-18)

Forward migration `0018_separate_catalog_inventory.sql` drops stock dirty triggers,
replaces settings dirty triggers with the published layout key list and actual
value-change guards, and dirties the catalog once for the snapshot cutover. It
contains no table reconstruction, data deletion or stock change. Its custom
metadata was generated in isolation with installed Drizzle Kit 0.31.11; the
migration drift check passes. Earlier applied migrations remain intact.

D1 inventory is read through a batched GET Start server function, internally
cached for five seconds by the Workers Cache API. Shopper requests occur at page
load/navigation only, with no refresh after adding to cart. No timers, focus refresh or
automatic retries are used. Unknown availability permits attempts; carts validate
status/quantity limits, and atomic checkout holds enforce stock. Old snapshots are readable but
their stock fields are discarded. Admin realtime notifications remain separate
from publication. Cron promotes due scheduled posts before dirty/recovery checks.

Before local 0018, verified dev/preview service trees (eight processes) were
stopped and both ports released. All 69 Wrangler state files, including SQLite
sidecars and local media, were copied and SHA-256 verified outside the repository:
`C:\Users\nicka\AppData\Local\store-backups\inventory-20261018-152232\state`.
Before-images of 308 source files preserve all earlier uncommitted work. Local
D1 applied 0018 successfully (11 commands); no remote migration ran. Undo source
changes using those per-file images. If reversing the applied database behavior,
retain 0018 and add a reversal at the next unused migration number, restore the
previous snapshot writer, and republish through `JOBS_RT`; do not reset history
or wipe data. See `docs/archive/REMEDIATION.md` for verification and remaining deployment gates.

## Audit round 1: staff HTTP boundaries and owner protection

Migration `0019_auth_permissions.sql` adds two user guard triggers. It does not
rebuild tables, change existing identities or touch commerce data. Both `owner`
and legacy `admin` count as protected roles; banned accounts cannot replace the
last unbanned owner/admin.

Better Auth 1.7.10's admin plugin remains available for internal permission
checks, role changes and session revocation. Customer deletion now uses the atomic
store path described in the follow-up below. Its complete
endpoint list supplies `disabledPaths`, blocking direct HTTP access while
preserving server-side API calls behind the store's staff/2FA and permission
checks. Self-service deletion refuses protected roles before anonymization.

Responsive uploads reference an existing media row and match its format.
The browser encodes JPEG, PNG and WebP variants in the original format; GIFs
retain their animation and use the serving route's original-image fallback.

### Audit remediation Round 2 — checkout, coupons and returns

Migration `0020_checkout_coupon_guards.sql` adds write guards and replaces the
one-use-per-email unique index with a non-unique lookup index. Per-order claim
uniqueness remains. The insert/update guards enforce each coupon's configured
`usage_per_customer`; new percentage values must be 0–100. Existing invalid
coupons remain unchanged and cannot be redeemed. No coupon counts, historical
redemptions or past order totals are recalculated.

A paid transition owns its coupon claim as well as its stock commitment. A late
payment can reuse its existing claim or atomically reclaim global and customer
capacity. If stock or coupon capacity cannot be recovered, the order receives
a durable late-payment refund operation. A zero-total order instead cancels and
creates one notification without a monetary refund. Notifications explain the
expired checkout rather than assuming the items sold out.

Validated zero-total Checkout Sessions complete on `no_payment_required` without
a PaymentIntent. Inventory, currency lock and receipt insertion use the same
transaction as paid sessions. Free-order returns use non-monetary approval and
optional once-only restocking. A declined PaymentIntent retains inventory and
coupon claims for retry, while terminal failure/expiry releases them. The local
expiry sweep can still clean up declined sessions with a known PaymentIntent.

Pending checkouts prevent currency changes atomically, including stale quote
insertion. Stripe receives the persisted order currency. The first completed
order's currency lock remains permanent. Return decisions and refund creation
are guarded in D1 so rejection cannot race a refund into existence, and an
active/successful return refund cannot be replaced by a non-refund decision.

## Audit remediation Round 3 — bounded recovery and consistent backups

Migration `0021_reconciliation_cursors.sql` only creates the named-cursor table.
It has matching generated metadata and performs no table reconstruction, wipe
or historical financial rewrite. The existing cron, `JOBS` and `JOBS_RT` remain.
Separate cursors bound reconciliation legs and resume older records; successful
checks advance with compare-and-swap so overlapping passes cannot rewind them.
Provider outages leave the affected leg's cursor unchanged. Confirmed missing
objects require Stripe's explicit 404 `resource_missing` response.

Backups discover schema, then capture the exported data and migration ledger in
one D1 transactional batch. Schema guards reject concurrent schema changes;
capacity checks reject more than 100,000 rows or a conservative 16 MiB SQL estimate
before returning values. A final byte check precedes the single R2 put. A
30-second capture deadline fails safely with a deduplicated operational alert.
The existing manifest, privacy exclusions, schema-only identity tables, indexes,
triggers and whole-file FTS restoration remain. The local SQLite adapter provides
the same rollback contract. Larger exports require a separate design.

Notification transitions enqueue their deterministic outbox IDs after commit;
enqueue failure leaves durable rows for existing cron recovery. This does not
make external email delivery exactly once. Cart additions use SQL increments
with existing status/limit checks and no stock check. Catalog assembly groups
variant/media rows once; the 5,000-product regression preserves completeness and
ordering. Preview CI builds its own preview-configured artifact before Wrangler.

Cloudflare's D1 and Workers pages list different paid invocation budgets; the
local combined-cron fixture instruments statements without claiming to reproduce
deployed enforcement. See SCALING.md for the official links, counts and limits.
No maintenance framework, historical coupon backfill or dependency upgrade was
introduced. Applied 0021 must be reversed only by a new forward migration.

## Audit follow-up: atomic deletion and currency-safe recovery

Forward migration `0022_atomic_deletion_and_currency_recovery.sql` adds nullable
refund recovery reasons and SQL guards for protected identities, immutable valid
recovery reasons and payment currency. It does not reconstruct tables or backfill
historical transactions. Earlier applied migrations remain unchanged.

The shared account-deletion helper uses one D1 batch for the current-role guard,
order anonymization, address deletion, nullable cart/return/post links and user
deletion. Identity children cascade; administrative auditing joins the same batch.
Rejecting any step rolls back the whole operation. Promotion and deletion cannot
interleave between eligibility and destructive writes. All owners and legacy
admins require demotion before deletion, in addition to the last-owner protections.

Better Auth 1.7.10 deletes credentials/sessions separately from its user write.
Administrative deletion therefore retains its guarded permission checks but uses
the store transaction instead of `auth.api.removeUser`. Self-service retains its
existing SDK endpoint and authentication/freshness checks. Its `beforeDelete`
callback performs the atomic deletion; the installed SDK's remaining cleanup is
safe when the identity is already absent. Actual endpoint/cookie/cascade regressions
must remain when upgrading the SDK. No secondary identity cache is configured.

Payment commitment compares order and current store currency inside its transaction.
It captures a failed recovery's reason before a concurrent settings change can
alter the explanation. Old-currency payments use the existing durable, stable-key
late-payment refund flow. The first `recovery_reason` is immutable; null legacy
reasons keep the capacity explanation. Free sessions cancel and notify once without
requesting a monetary refund. Store currency and historical order currencies stay
unchanged by this recovery.

Money is summed only within an order currency. Both admin summaries use the shared
currency-grouped revenue query; product/customer export grouping gains currency.
Existing sales grouping and individual-order amounts retain their behavior.
This makes pending/failed old-currency recoveries explicit without converting or
rewriting accounting records. Public URLs and account-action inputs are unchanged.

## Scalability refactor (Phases 0–6)

The single-KV-snapshot catalog, the shared `JOBS_RT` queue and inline
webhook processing are superseded. Catalog reads use partitioned,
versioned KV read models fed by transactional D1 change capture (stock
stays live in D1); the snapshot table and modules are deleted
(migration 0005). Public HTML caching moved to Workers Cache behind
the `PublicStorefront` entrypoint with scoped tag purges. Queues are
separated by failure mode (`JOBS` financial, `NOTIFICATIONS`,
`CATALOG_JOBS`, one shared DLQ), realtime broadcasts are direct DO
calls, and checkout starts are admission-controlled by
`CheckoutAdmissionDO` with conservative, admin-editable defaults.
Webhooks are durable-only: the route records and enqueues, cron owns
recovery, and staff replay (owner/admin, audited) re-enqueues under the
original event identity. Detailed phase evidence lives in
`docs/archive/REMEDIATION.md`; deployed cache and throughput behavior remain
deployment acceptance items, not local claims.

## Superseded: automated D1 backups removed

The scheduled/manual SQL backup exporter (R2 `BACKUPS` bindings, `backup-capture`/`backup-manifest`, `backup:local`/`backup:restore` scripts and their tests) is removed. D1 Time Travel is the recovery path: always on, 30 days on Paid and 7 days on Free, in-place restore that can be undone with the pre-restore bookmark. It supersedes the earlier backup decisions above, including the Round 3 bounded-recovery entries. Off-site copies use per-table `wrangler d1 export` because a whole-database export cannot handle the `products_fts` virtual table; see 'Backups and recovery' in the root README. Existing `store-backups` buckets are not deleted by removing the binding; the account owner deletes them manually.

## Resolved: dead-lettered webhooks are never terminal

Decision (superseding the original refactor plan's quarantine-until-replay text): an exhausted webhook event is parked as `dead`, the operator email fires once, and the cron sweep (`reprocessStaleInbox`) replays it after a fixed 6-hour delay; if it exhausts again it returns to `dead`. Guarded staff replay (owner/admin, audited, original event identity) remains available at any time. This follows the owner's later explicit instruction during the audit rounds, not the attached plan's earlier quarantine wording; the conflict is recorded here so the plan text is not silently treated as the policy. Behavior is covered by `tests/webhook-replay.test.ts` and the inbox lifecycle tests.

## Architecture completion Round 1: frozen history and checkout recovery

The applied `0008_publication_progress.sql` was edited after application and its
local page-revision table was manually repaired during the preceding work.
That history is not rewritten again. The 2026-10-21 comparison of a consistent,
read-only local SQLite backup with a fresh chain through 0008 found 226 matching
schema objects and no foreign-key violations. A preserved pre-0008 database was
not found, so the old page-copy result remains historically unproven. Round 2
must rebuild derived catalog data using the corrected publisher. Physical parity
now does not prove that the old copy preserved every page then.

`0009_checkout_recovery_guards.sql` adds provider-attempt/step/creation-stop
metadata without rebuilding tables. Existing creating/reconciling attempts have
unknown first-attempt evidence and stop creation conservatively. Known sessions
remain retrievable and matching paid webhooks remain processable. Normal hold
expiry may release stock without erasing the unresolved provider operation.

Shared cancellation statements use a transition identity, and account deletion
selects eligible orders inside the guarded deletion transaction. Provider results
must pass the current claim token, generation, expiry, order and session guards.
New HTTP submissions must carry the quote actually confirmed by the shopper;
retries retain frozen parameters and stable operation identities. The 23-hour
creation horizon is a fixed safety boundary for Stripe idempotency retention,
not a configurable store limit.

The current requirement and acceptance ledger is
`docs/archive/ARCHITECTURE-COMPLETION.md`. Earlier completion statements in REMEDIATION
are historical checkpoints, not final acceptance of the remaining rounds.

### 2026-10-22: coherent published readers and local migration checkpoint

With explicit user approval, ordinary local D1 was upgraded through 0010 and 0011. The latter adds only indexed title/ID collection ordering and indexed
post status/date/ID ordering. It performs no table reconstruction or financial
backfill. Fresh-chain and populated local schema definitions match (239 objects,
zero differences); FK checks are clean. Historical 0008 copy verification remains
unproven. Derived catalog data was regenerated through the corrected actual
queue handler, first on a copy and then locally, rather than asserting that the
historical copy was correct. Before-images and full stopped persistence backups
with SHA-256 manifests are recorded in REMEDIATION.

The reference owns publication counts and pins immutable directory/page values
and collection metadata. Product/editorial misses use committed document mirrors,
never unpublished source. Editorial and collection metadata pointers name
immutable revisions; request-local promises keep nested loaders coherent.
Navigation and home teasers share the fixed layout; collection/journal discovery
uses bounded published pages. Mutable-reference delivery and queued index work
must finish before a successful unit stops scheduling continuations.

Round 4 reclamation is now migration 0012 and remains a separate approval stop.
The user's focused-checks-only instruction defers full ordinary and 100k
acceptance reruns; no current production-readiness claim is made.

### 2026-10-22: final refactor phase - conservative catalog reclamation

Approved Phase 4 uses forward migration 0012; applied historical SQL is unchanged.
Reclamation has durable inventory/mark/sweep cursors, bounded root traversal,
lease/revision guards and retryable KV-first deletion. All nonterminal builds
block collection, including paused checkpoints. Retained publication history gets
seven days, then artifacts get seven days from observed loss of their final
retained reference. Delayed reclamation is preferable to deleting a live artifact.
This does not introduce a maintenance queue or scheduler.

Incremental layout publication now commits its exact durable reference and
historical document membership before normal timed KV delivery. Otherwise GC
could protect the wrong layout. The existing checkout/availability behavior,
financial policies, committed reservations, six-hour dead-webhook retries and
staff replay permissions remain unchanged.

The obsolete checkout load probe was removed: its request contract was no longer
valid and all-rejected requests could look successful. A focused native-process
runner records each exit status immediately and fails on errors. No hidden retry
makes a failed gate green. Full ordinary and isolated 100k gates remain deferred
by explicit user instruction; deployment acceptance is still open. Phase 4 is the
last implementation round, not a claim that every external release gate passed.

## 2026-10-22 — Authorization before allocation (supersedes D10 and hold defaults)

New attempts use hosted Checkout Sessions with manual capture. Preparation freezes
app-owned shipping/address/cart identity and a Session-backed review without stock
or coupon claims. Confirmed authorization is validated, then D1 allocates capacity
atomically before capture. Verified capture finalizes inventory/ledger/receipt
transactionally. Zero-total orders use one guarded capacity/finalization batch.
Uncertain capture never releases allocations merely because a hold expired.
Stable operation identities, retrieval, fencing and cancellation/refund recovery
cover supersession and account deletion.

checkout_session_minutes replaces the misleading hold setting (32, range32–1440).
Old immutable layouts are hash-verified unchanged and map the old limit key only
in their returned view. No historical accounting is rewritten. Start server
functions now explicitly use the documented same-origin CSRF middleware.

Publication wakes on actual work. Existing queues carry bounded durable maintenance
continuations: financial15m, privacyhourly, historical/retention/reminders/replica/GC
daily. No new queue resource is provisioned. Reminders default off with per-order
consent and suppression. Immutable public R2 delivery is optional and requires
actual variant publication metadata and recoverable storage deletion/CDN purge.

Latest user direction supersedes checkpoint test/review pauses: finish all source
changes, then run verification next phase. Migrations0013–0015 are prepared only.
No unit/scale/browser/provider checks are claimed for this new lifecycle.

## 2026-10-23: hosted Checkout and recovery completion

The user selected hosted Stripe Checkout over v1.2's inline Payment Element.
The application still owns shipping, discounts and final review. Unpaid checkout
preparation reserves no stock. Allocation follows verified authorization.

The hardening implementation reuses maintenance_runs and existing queues for
independent financial families, bounds provider maintenance by a shared 30-second
deadline, and registers public media destinations before storage writes. Known
public destinations and incomplete uploads remain available to deletion recovery.
Migration 0016 is prepared only. Implementation details and pending verification
are in [CHECKOUT-HARDENING.md](archive/CHECKOUT-HARDENING.md). No readiness claim is
made for this untested checkpoint.

## 2026-10-23: conditional recovery, existing infrastructure

Replace unconditional financial-family starts with shared due-work predicates and
a deduplicated watchdog dispatch pass. Preserve the existing independent families,
D1 business records, queues and periodic audits. Notification recovery belongs to
NOTIFICATIONS and only enqueues delivery IDs; it does not send email on JOBS.

The only dependency addition is the exact development dependency
@types/node 24.19.2 and its undici-types dependency; retained package versions did
not change. Optional application bindings use WorkerEnv rather than relying on
local-secret inference in generated types. Migration 0017 is index-only and remains
unapplied. Verification is deferred: see
[RECOVERY-WATCHDOG.md](archive/RECOVERY-WATCHDOG.md).

## 2026-10-24: v4 audit hardening

- **A build is done only once its references are delivered.** The deliver phase
  counts pending references up to the sequence the build committed. A key written
  less than a second ago stays pending, and the unit retries after two seconds;
  KV allows one write per second per key. `verifyChangedReferences` logs
  `catalog_ref_mismatch` when KV holds a different reference than D1 expects.
- **A collection slug never changes after creation.** Edits cannot leave a
  published collection URL stale, so a rename needs no old-slug purge.
- **`catalog_invalidations` has no `AUTOINCREMENT`.** A reused rowid is safe
  because the purge cutoff compares the rowid and the write time, and a test pins
  it.
- **An unreachable admission controller backs settlement off for 60 seconds.**
  Checkout start answers `503 CHECKOUT_UNAVAILABLE` instead of failing open;
  settlement retries after a minute. A busy controller retries after its hint
  plus up to four seconds of jitter.
- **Customer exports use camelCase keys** in both the self export and the admin
  export. The discount check takes no email: the per-customer cap is evaluated
  for the signed-in account, and checkout enforces it for every order.
- **CSRF covers unsafe `/api/*` requests, including `/api/auth/*`.** A sign-in
  POST with no Origin, Referer or Sec-Fetch-Site gets 403. The Stripe webhook is
  exempt because Stripe signs it.
- **Media keys are unique per upload, so `/media` is `immutable` for a year.** A
  deleted image can stay in browser caches for that long; there is no edge copy
  to purge.
- **The CSP keeps `script-src 'unsafe-inline'` (D12) and gains HSTS.** A nonce or
  hash policy is deferred until after launch.
- **MONEY-06 follow-up closed.** The reserve-before-payment path and the payment
  arms it left unreachable are deleted. Every order has exactly one checkout
  intent, and every Stripe session carries `order_id` and `attempt_id`.
- **The first deploy needs a recreated remote D1.** Migrations were edited in
  place across the audit phases, so a remote database that applied the old chain
  cannot be upgraded. Workers Paid is required. A cold edge cache after each
  deploy is by design (`cross_version_cache: false`).
- **Accepted audit findings.**
  - Caching bills the loopback as its own request, so each public HTML view costs
    two billed requests plus gateway CPU (CAT-10). Billed invocations are
    measured on the preview.
  - The stale-claim check compares `updated_at`, not a claim time (CAT-14). Lease
    fencing bounds the damage, and a `claimed_at` column is a schema change.
  - A resolvable pointer whose document is missing or invalid throws and renders
    a 500 (CAT-15). That state means corruption, so it fails loudly.
  - The gateway renders again only when the storefront entrypoint itself throws
    (CAT-16). Application errors come back as a 500 response.
  - Admin actions read `catalog_publication_state` twice (SEC-L15). Both are
    indexed one-row reads; removing them would enqueue a wake-up for every action.

## 2026-10-26: persistent product options (pending)

- **Status: `pending`.** Phase 3B, as shipped in the combined Phase 3A and 3B
  product-creation PR, is a combination generator. It saves flat variants only.
  Option group names and values are not stored, and variant titles such as
  `Small / Black` cannot be parsed back into an option structure reliably,
  because a value may itself contain ` / `.
- No Phase 4 editor code, and no other dependent code, may assume that a
  product's option groups can be reconstructed from its variants. The Phase 4
  editing workspace must be designed against flat variants until this decision
  is approved.
- The decision to take before Phase 4 design starts: whether to add persistent
  product options (stored groups and values, editor reconstruction, and
  storefront Size and Color selectors) as its own scoped schema and catalog
  publication change. That work is deliberately not part of the Phase 3
  remediation PR.

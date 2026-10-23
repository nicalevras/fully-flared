# Authorization-first Checkout implementation ledger

Status: source implementation A–E is connected; runtime acceptance is pending.
The latest user instruction is to complete the changes without checkpoint stops
and run tests in the next phase. No test suite, scale test, browser journey or
real provider call was run for B–E. Migrations0013–0015 were subsequently applied locally with explicit user approval; see the application evidence below.

## Boundaries and before-images

Hosted Stripe payment page; app-owned address, delivery, discounts and review.
No stock/coupon claim before authorization. Uncertain capture retains allocation.
Existing quantities, backorders, guest/account ownership, page-load availability,
financial restrictions, six-hour dead-webhook recovery and established UI remain.
No commits, pushes, deployment, remote operations or dependency upgrades.

Verified source backups:
C:/Users/nicka/store-remediation-backups/20261022T223440Z/authorization-first/

- before/: 350 source files, hash-verified before A.
- continued-before/: 353 source files, hash-verified before resuming B–E.
- Revision/status, binary diffs and SHA-256 manifests accompany the copies.
  No Wrangler-state backup is claimed: migration application is deferred.
  The unrelated new-plan.md remains untouched.

## Checkpoints

| Checkpoint | Connected implementation                                                                                                                                                                                                                       | Verification status                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A          | Retryable disputed late recovery; won-dispute event wake; old slug pointer retirement/invalidation; CATALOG_JOBS deployment consumer; CI typegen; fixture-only attach helper                                                                   | Historical A-only run: 7 tests/2 files, exit0; A typecheck exit0. These results do not validate B–E.       |
| B          | Additive manual-capture intent metadata; provider retrieval/deadline wrappers; fenced allocation/capture/cancel; strict quote/amount/currency identity; zero-total guarded finalization; cancellation/deletion preserve unresolved identifiers | Prepared0013; financial race/provider regressions deferred                                                 |
| C          | Full app address and Session-backed review; explicit confirmation; attempt-specific Customer; card-only/manual capture; detail/cart supersession; unchanged-cart conversion after sale; manual retry and cancellation                          | Source connected; tax destinations, exemption, Session/account compatibility and browser journeys deferred |
| D          | Work-revision wake; due-only cron; delivery-gated durable invalidations; changed-reference checks; separate daily replica/GC; slim cards and prewrite byte checks; bounded maintenance continuations on existing queues                        | Prepared0014; queue, coverage and artifact assertions deferred                                             |
| E          | Optional public R2 originals/actual immutable variants; recoverable deletion/purge; editorial/SEO URLs; semantic cache keys; cookie-count hydration and shared cart result; removed superseded entrypoints/production helpers                  | Prepared0015; CDN/deletion/browser checks deferred                                                         |

The timestamp audit claim is withdrawn: the normal replica writer already uses
matching SQLite timestamps. The faulty probe used a different ISO representation.

## Original audit coverage

| ID    | Implementation or explicit remaining gate                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FF-01 | Settled provider scans skip unchanged writes/redundant queue sends; maintain a no-op regression next phase                                              |
| FF-02 | Production unfenced attach export removed; fixtures use tests/helpers/attach-session.ts                                                                 |
| FF-03 | Ordinary suite and actual-queue100k final acceptance deferred                                                                                           |
| FF-04 | Real Stripe, deployed propagation/admission/throughput and soak require separate authorization                                                          |
| FF-05 | Prepare/review/confirm, busy Retry-After, manual retry, stale details, abort support, explicit processing/confirmed/canceled/refunded/disputed outcomes |
| FF-06 | Existing exact pinned fallback retained; renamed pointers retired; reference repair targets committed artifacts                                         |
| FF-07 | Only actual transactional catalog work revision changes enqueue publication                                                                             |
| FF-08 | Indexed due/interrupted/reference/editorial checks replace unconditional cron publication                                                               |
| FF-09 | Changed-reference delayed verification; complete bounded daily replica sweep                                                                            |
| FF-10 | Separate financial/privacy/historical/retention/reminder/replica/GC responsibilities, durable continuations                                             |
| FF-11 | Daily audit keeps cutoff and per-run cursors until all bounded stages complete                                                                          |
| FF-12 | Hourly bounded IP scrub; daily bounded retention; default-off consent/suppression reminders with keyset progress                                        |
| FF-13 | GC inventory upsert updates only actual changed metadata                                                                                                |
| FF-14 | Due scheduled posts promoted in bounded50-row units; missed wake recovered by safety tick                                                               |
| FF-15 | Optional PUBLIC_MEDIA, actual ready variant manifest, storage deletion/purge retained for manual retry                                                  |
| FF-16 | Deployed static routing/billed invocation measurements pending; no speculative routing change                                                           |
| FF-17 | Route-specific semantic page parameters and sorted cache keys                                                                                           |
| FF-18 | Badge hydration reads only cosmetic cart_count cookie; capability remains HttpOnly                                                                      |
| FF-19 | Share cart mutation results/coalesce refresh; later mutations fence stale reads                                                                         |
| FF-20 | Five-second availability policy unchanged; Cache API batching overhead benchmark deferred                                                               |
| FF-21 | Financial/security logs retained; measured logging cost remains external gate                                                                           |
| FF-22 | Financial/maintenance dispatch extracted from gateway; existing JOBS/NOTIFICATIONS/CATALOG_JOBS reused                                                  |
| FF-23 | 1.5MiB artifact prewrite ceiling and8MiB invocation budget; actual D1/KV/media/history byte capacity still needs measurement                            |
| FF-24 | HTML TTL/private boundaries unchanged; supported-host HIT/MISS, p50/p95, regional visibility and purge staleness pending                                |
| FF-25 | Durable progress/cutoff, oldest due/unfinished ages and authorization overdue alerts; latency target unproven                                           |

## Migration and compatibility contract

0013_authorized_checkout.sql adds flow/frozen cart/address/review and payment
operation state. Existing rows default legacy. checkout_session_minutes defaults32
and accepts32–1440; old attempts retain their recorded deadlines. Authorized
allocation release is guarded while capture remains unresolved.

0014_event_driven_operations.sql adds durable work/reference/invalidation state,
maintenance progress and reminder consent/suppression. 0015_public_media_delivery.sql
adds published originals and ready/claimed responsive-variant metadata. Matching
Drizzle snapshots/journal are prepared. No historical migration was modified,
table reconstructed, inventory wiped or accounting backfilled.

These migrations are now APPLIED LOCALLY. Remote application remains unauthorized. Local application followed a complete hash-verified stopped-state backup;
next-phase acceptance still needs fresh/populated path rehearsal and financial scenarios. The new
checkout/media handlers require these columns. Old layout artifacts remain
hash-verified and map the old limit name in the returned view only; that does not
permit running the new checkout against an old database.

## Financial release blockers

- Session-backed review, authorized and captured amount/currency must match
  exactly, including shipping, discounts and tax. No browser-granted exemption.
- Superseded attempts cannot fulfill; expire open Sessions, cancel requires_capture
  authorizations, retrieve uncertain capture and compensate captured cancellations.
- Atomic allocation and sale/stock/ledger/receipt; no timer releases uncertain
  capture allocation. Zero-total orders never create monetary refunds.
- Account deletion is atomic and strips personal/replay data while preserving
  reconciliation identifiers and durable cancellation intent.
- Immediate event processing, warning after five minutes unresolved authorization,
  escalation at the15-minute safety tick are targets, not forced-expiry rules.
  Provider outages leave visible recovery work; they cannot justify inventory release.

## Next verification phase

First formatting/types/build/drift and fresh/populated migration paths, then
focused financial/tax/cart/dispute/media/coverage cases. Run the ordinary suite
once and isolated100k queue gate, retain failures and diagnose without weakening
assertions. Disposable local HTTP/browser journeys use stub providers. No actual
Stripe charge, supported-host caching, billing, sustainable throughput or soak
claim follows from local checks.

The reported layout error was addressed by adapting old published limit names
without changing artifact hashes. src/start.ts now explicitly installs Start's
CSRF request middleware filtered to serverFn, retaining functionBoundary. Neither
change has a runtime acceptance result yet.

## Documentation basis

Context7 Start server middleware documentation and installed1.169.3 exports:
https://tanstack.com/start/latest/docs/framework/react/guide/middleware

Stripe23 installed types and official manual-capture/tax documentation:
https://docs.stripe.com/payments/place-a-hold-on-a-payment-method
https://docs.stripe.com/tax/checkout/page
https://docs.stripe.com/api/payment_intents/cancel
https://docs.stripe.com/api/idempotent_requests

Cloudflare transactional D1 and delivery semantics:
https://developers.cloudflare.com/d1/worker-api/d1-database/
https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
https://developers.cloudflare.com/queues/configuration/batching-retries/

Stripe Checkout PI direct cancellation is restricted to requires_capture;
otherwise expire the open Session. Account-level Stripe Tax/wallet behavior and
actual public media purge propagation remain provider/deployment gates.

## Local migration application — separately authorized

The user requested the migrations now. check:migrations exited0 and reported
matching schema metadata with no table reconstruction. Wrangler4.151.1 applied
0013,0014,0015 to store-db with explicit --local --config wrangler.jsonc; exit0.
The local ledger confirms all three; foreign_key_check returned no rows,
quick_check returned ok, stock_ledger_mismatches was0. Session duration is32
and reminders remain disabled. This is migration/invariant evidence, not payment
acceptance. No remote database or provider call was made.

Complete stopped-state backup (114 files,18 WAL/SHM, all SHA-256 hashes matched):
C:/Users/nicka/store-remediation-backups/20261022T223440Z/authorization-first/local-migrations-20261022T234712Z/wrangler
Migration/integrity logs and stopped/restored service manifests are in its parent.
Previously running dev8799, preview8800 and dev5173 were restarted sequentially
in hidden processes. Preview still serves its existing build; build/browser and
financial acceptance remain next-phase work. Schema reversal requires a new
forward migration; do not restore only the database beneath dependent code.

## Provider integration correction

The user's manual checkout exposed an unsupported Stripe23 creation parameter:
payment_method_types. The adapter now uses allowed_payment_method_types:['card']
and directly validates its request fragment against installed SessionCreateParams.
Safe rejection diagnostics and a deferred SDK-mocked regression were added.
Typecheck passes; successful provider completion and the financial acceptance
scenarios remain unverified. Source completion must not be treated as a working
end-to-end payment guarantee. Details and backup path are in REMEDIATION.md.

## 2026-10-23 checkout-hardening checkpoint — verification pending

The approved amendment retains hosted Stripe Checkout. Cart-bound attempt identity,
pre-finalization full-refund compensation, independent financial recovery families,
shared provider deadlines, purge-result handling and recoverable public media
publication are implemented in the working tree. Migration
`0016_checkout_and_media_recovery.sql` is prepared and **not applied**.

See [CHECKOUT-HARDENING.md](CHECKOUT-HARDENING.md) for the requirement ledger,
operator workflow, migration/rollback procedure and deferred acceptance cases.
Historical green results above do not verify these changes. Tests, typechecks,
builds, drift checks and provider/browser journeys are intentionally deferred until
the user's review pause. No commits, pushes, deployments or remote changes ran.

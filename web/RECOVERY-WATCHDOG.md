# Conditional recovery checkpoint — 2026-10-23

Implementation only. No lint, tests, type generation, typecheck, build, migration
checks, database migrations, browser journeys or provider calls ran at this
checkpoint. CI repair is implemented but not yet verified. Do not treat this
document or earlier green results as production acceptance.

## Architecture and changes

Keep hosted Stripe Checkout and the existing authorization-first purchase flow.
D1 inbox, outbox, attempts and maintenance records remain the durable authority.
Keep JOBS, NOTIFICATIONS, CATALOG_JOBS and their shared dead-letter queue. No new
orchestration service, queue, Durable Object or scheduler table is introduced.

| Requirement                                     | Implementation                                                                                                                                                                       | Verification deferred                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Repair confirmed CI errors                      | Diagnostic regex preserves brackets without the unnecessary escape. Optional secrets/media consumers use WorkerEnv. Node 24 declarations are a direct pinned development dependency. | Clean environment without .dev.vars, lint, typecheck and build.                                                          |
| Generate types before source-consuming CI steps | Worker type generation moves immediately after dependency installation in lint-and-test. Other build/deployment jobs retain generation before their build.                           | Execute equivalent CI gates later; do not hand-edit generated Env declarations.                                          |
| Shared due rules                                | recovery-eligibility.ts supplies the watchdog and processors with the same SQL predicates, one clock, fixed coverage cutoff, configured limits and recipient snapshot.               | Boundary timing, future retry, active and expired claims, price/payment protections.                                     |
| Conditional financial watchdog                  | Create runs only for eligible families without an unfinished run; combine them with runnable existing runs and deduplicate dispatch by run ID.                                       | Fully initialized idle store: zero new runs and zero Queue sends.                                                        |
| Independent failure recovery                    | Per-family checks and dispatch use settled results. Failed enqueueing retains durable runs. Backoff/live claims prevent premature wake-ups.                                          | One failed check or send does not block unrelated work.                                                                  |
| Legacy financial compatibility                  | Existing staged financial runs call the same due-work discovery; no new staged financial runs or unconditional seven-family fan-out are created.                                     | Partial legacy runs, already completed operations, concurrent wake-ups.                                                  |
| Outstanding operational alerts                  | Retry eligibility includes missing authorization overdue/escalation alerts and missing stuck-refund alerts, using exact existing outbox IDs per recipient.                           | Alert-only work, partial recipient coverage, duplicates and threshold boundaries.                                        |
| Notification isolation                          | Outbox recovery runs on NOTIFICATIONS and only enqueues email.send IDs. processOutboxRow retains send claims, retry limits and stale-claim recovery.                                 | Financial workers send no email; duplicate delivery remains harmless locally.                                            |
| Bounded outbox coverage                         | At most 25 rows per delivery, ordered by created_at/id, with cutoff and cursor persisted in maintenance progress. Save only successfully enqueued positions.                         | More than 25 rows, tied timestamps, partial enqueue failure, restart, no looping over still-pending first-page messages. |
| Preserve maintenance responsibilities           | Hourly privacy, daily audits/retention/optional reminders/replica/GC, conditional catalog checks and durable cache invalidation remain.                                              | Failure isolation, scheduled content, recovery completion and coverage age.                                              |

## Queue routing and recovery

JOBS processes financial events and recovery. NOTIFICATIONS processes actual email
delivery and its outbox recovery dispatcher. CATALOG_JOBS processes catalog work,
replica checks and reclamation. Existing immediate after-commit enqueueing stays.

The 15-minute watchdog checks business-record eligibility and unfinished
maintenance runs. It does not create seven empty runs on each tick. An existing
run with a future retry time or a live claim remains untouched. A continuation
retains its fixed coverage cutoff, and work arriving later remains eligible for a
subsequent watchdog sweep. Existing due runs can finish even if a concurrent
consumer already resolved their last business record.

Each business processor uses the shared eligibility predicate. Remaining work
continues in bounded units; admission refusal or no progress with remaining work
delays the next unit by 60 seconds. Existing 30-second provider budgets,
ten-second call ceilings, operation fencing and retry/idempotency policies remain.
Dead webhooks retain their six-hour retry policy and are not permanently discarded.

Outbox recovery is a finite pass, not a loop waiting for emails to be sent. Its
cursor advances only after an enqueue succeeds. A send failure retains the failed
position and retry timing. A crash between enqueue and cursor persistence can
redeliver a bounded prefix; the existing consumer claim protects the send.
Only the notification consumer performs delivery. Ambiguous external email
delivery can still redeliver: transport is not exactly once.

Authorization alerts retain five-minute overdue and fifteen-minute escalation
thresholds. Refund alerts use the configured attempt/age thresholds. Recipient
lookup failure is logged and does not prevent unrelated retry work; missing alert
rows are discoverable when the recipient lookup recovers. Existing alert IDs remain
the deduplication constraint. No financial history is backfilled.

Watchdog logs report eligible families, due runs, accepted dispatches, failures and
oldest due/unfinished ages from its bounded active-run lookup. SQL indexes are
prepared, but query plans and actual rows read have not been measured. An EXISTS
query is not itself a performance proof.

## Dependencies and CI

Added web development dependency **@types/node 24.19.2** and its dependency
**undici-types 7.24.6**. Lockfile inspection found zero changes to retained package
versions and zero removed packages. No runtime dependency was added or upgraded.

WorkerEnv declares application-level optional secret/public-media names, while
Cloudflare.Env remains generated from configured bindings. CI must not depend on
local .dev.vars inference, fabricated secrets or a fake PUBLIC_MEDIA binding.
The real public-media configuration remains optional.

## Migration and rollback

Prepared **0017_due_recovery_indexes.sql**, matching snapshot and journal metadata:

- Outbox retry eligibility and stale sending claims.
- Refund retry timing, age and attempt thresholds.
- Pending-webhook received time.

The generated SQL contains six CREATE INDEX statements only. Existing order,
reservation, checkout and maintenance indexes are reused. No historical migration
was edited. Migration 0017 is not applied; outstanding 0016 is not applied by this
checkpoint either. Generation ran in an isolated temporary folder, exited 0, and
only the new SQL/snapshot and journal update were copied back.

Before any local migration, stop verified workspace services, back up all Wrangler
persistence including WAL/SHM files, verify hashes, then apply only after approval
for that checkpoint. Restore previously running services afterward. Before
migration, undo uses this checkpoint's working-tree before-images; afterward a
schema reversal requires a new forward migration. No blanket Git reset is needed.

## Next checkpoint

### Review follow-up: routing and progress

Generic `enqueueJob` rejects `maintenance.run` with a structured failure instead
of guessing a queue. All maintenance wake-ups use the existing task-aware
dispatcher; outbox recovery continues on NOTIFICATIONS.

Authorization and refund recovery count a selected operation only after a
bounded identity lookup confirms it has left the captured due set (completed,
claimed elsewhere, or durably deferred). Unchanged eligible operations count as
zero progress, allowing the maintenance runner's existing 60-second retry delay
to apply. This deliberately treats intermediate changes that remain immediately
due conservatively. Alert creation remains separately counted.

Added unrun regressions for generic maintenance routing rejection, a refund
failure before claiming, durable refund deferral, and a lost authorization claim.
No test, type/build, migration or query-plan verification has run for this
follow-up. Index necessity remains pending EXPLAIN QUERY PLAN at the verification
checkpoint; 0017 remains unapplied and unchanged by this follow-up.

Add focused scheduler/outbox regressions and run the existing affected tests. Two
existing test callers were adapted to the removed direct-send helper; neither was
run. Retain assertions on notification enqueueing, no premature delivery, send
claims and PII-safe failure logs.

Verify clean dependency installation and Worker declarations without local secret
files, then lint, formatting, typecheck/build and migration drift. Exercise fresh
and populated migration chains through 0017 on disposable state, and inspect
EXPLAIN QUERY PLAN for every eligibility category. Include independent failures,
expired claims, missing alerts, six-hour webhook retries, backoff, duplicate
wake-ups, legacy runs and outbox pagination/failure recovery.

Retain focused financial acceptance: final-unit/coupon races, capture uncertainty,
cancellation, full-refund compensation and confirmed totals. The ordinary suite,
isolated 100k gate and deployed/provider measurements remain separate acceptance
checkpoints. No cost, scale or production-readiness result is claimed here.

## Backup and documentation basis

Before-images, SHA-256 manifest, revision/status and staged/unstaged binary diffs:

`C:\Users\nicka\store-remediation-backups\20261023T113126Z\conditional-recovery\`

373 files matched source/copy SHA-256 hashes before editing. New files and the final
source inventory are recorded alongside the backup. The baseline was clean commit
`a26d8ca83e0606c66d07dc0c8edda62c8e391f2b`.

Context7 documentation retrieved during plan preparation supports
[Wrangler's generated types](https://developers.cloudflare.com/workers/wrangler/commands/#types)
and [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).
Installed Wrangler remains 4.151.1. Generated code is not evidence that migrations
were applied or that CI passed.

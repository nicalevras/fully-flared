# Fully Flared completion ledger

This is the current acceptance ledger for the original architecture, the audit,
and the approved four-round completion plan. Earlier results in REMEDIATION are
historical checkpoints. A passing old checkpoint does not close the remaining
requirements here. Round 1 code and local test gates pass. Migration 0009 was
applied to ordinary local D1 after explicit approval on 2026-10-21; the stopped
Wrangler backup and verification are recorded in REMEDIATION. Round 2 repairs have focused evidence; full ordinary and 100k reruns are deferred
by the user. On 2026-10-22 the user authorized local migrations and Round 3.
0010 and the index-only 0011 are applied locally. Round 3 reader work is
implemented with focused and actual HTTP evidence below; final architecture
acceptance remains open. Round 4 (migration 0012) is implemented and applied locally with focused
evidence below. Full architecture and deployment acceptance remain open.

## Round 1: commerce and recovery

| Requirement                                               | Implementation                                                                                                                                      | Regression / evidence                                                                                          | Acceptance                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Preserve working tree and pin before-images               | Verified 285-file SHA-256 manifest, revision, status, staged/unstaged binary patches                                                                | Round-1 backup manifest                                                                                        | Verified before edits                                                   |
| Freeze historical migrations and compare physical schemas | No edits to 0000-0008; read-only consistent SQLite backup compared with fresh chain                                                                 | schema-parity.json: 226 objects, zero differences, zero FK violations                                          | Verified locally through 0008                                           |
| Applied 0008 alteration and historical copy               | Historical edit/manual repair disclosed in DECISIONS; no pre-0008 copy found                                                                        | pre-0008-evidence.json and candidate inventory                                                                 | Historical copy unproven; corrected derived rebuild required in Round 2 |
| Narrow destructive SQL exceptions                         | check-migrations permits only named table drops in 0005 and 0008, rejects reconstruction anywhere                                                   | check:migrations; fresh-chain tests                                                                            | Passed locally; Round-1 evidence in REMEDIATION                         |
| Atomic fenced attachment                                  | Token, fence, expiry, order identity/state and compatible session guarded before order/intent writes; webhook attachment also atomic                | commerce-completion: stale worker, expired lease, injected ready-write failure; checkout-intents early webhook | Passed locally; Round-1 evidence in REMEDIATION                         |
| Shared guarded cancellation                               | order-cancellation statement builder tags transitions, retires/reconciles intents, releases only transitioned holds/coupons                         | cancellation rollback, payment/expiry races in audit-round2; inventory ledger assertions                       | Passed locally; Round-1 evidence in REMEDIATION                         |
| Provider safety metadata                                  | 0009 adds first attempt, current creation step, creation-stop timestamp; legacy uncertain rows stop creation conservatively                         | Populated 0008 upgrade, fresh install; ordinary local migration exit 0                                         | Applied locally; integrity/FK/business-data checks pass                 |
| Creation horizon in all initiation states                 | Frozen payload, stable identities; stop before 23-hour key horizon or invalid frozen expiry; retrieve known session first                           | reserved/creating/reconciliation horizon cases, retrieval after expiry                                         | Passed locally; Round-1 evidence in REMEDIATION                         |
| Uncertainty distinct from stock policy                    | Normal hold expiry can cancel/release; unresolved intent and provider identifiers survive, creation stops                                           | Expiry with unresolved session; definite-rejection atomic rollback                                             | Passed locally; Round-1 evidence in REMEDIATION                         |
| Durable unresolved alerts                                 | Claim/fence guard, creation-stop and deterministic outbox insert in one batch                                                                       | Repeated stop produces one outbox row and stable stop timestamp                                                | Passed locally; Round-1 evidence in REMEDIATION                         |
| Bounded provider discovery                                | Existing paged session scan matches metadata to intent and enqueues durable synthetic inbox work under stable identity                              | Provider discovery duplicate test; existing reconcile tests                                                    | Local/stubbed only                                                      |
| Per-call budget and admission                             | Remaining-budget timeout, maximum 10 seconds for initiation calls; no call after deadline; existing admission wraps new/resumed operations          | Deadline/retrieval budget tests and checkout-admission                                                         | Local/stubbed only; deployed admission remains pending                  |
| Atomic set-based account deletion                         | Role guard, target-user cancellation, intent scrub/retirement, privacy writes and cascades share batch; no preliminary enumeration authority        | Insert immediately before deletion batch, rollback, protected-role and promotion tests                         | Passed locally; Round-1 evidence in REMEDIATION                         |
| Account existence at creation                             | In-batch user guard before any order/hold mutation                                                                                                  | Creation after deletion rejects with no orders                                                                 | Passed locally; Round-1 evidence in REMEDIATION                         |
| Confirmed quote contract                                  | New HTTP submission requires revision and totals; computed quote passed into reservation transaction; revision guard retained                       | Missing/stale/matching quote tests, currency/config races                                                      | Passed locally; Round-1 evidence in REMEDIATION                         |
| Browser completion                                        | Safe storage-property access with memory fallback; authenticated loader flag bypasses guest bootstrap; guests retain Web Locks and capability reuse | Storage getter and reuse tests; existing response-loss/bootstrap lock tests                                    | Browser-engine Web Locks propagation remains external acceptance        |
| Preserve policies                                         | Checkout-only stock reservation; page-load availability unchanged; currencies/returns/replay policy retained                                        | Ordinary suite; six-hour dead-webhook tests                                                                    | Passed locally; Round-1 evidence in REMEDIATION                         |

## Round 2: catalog execution repairs; 0010 applied locally

The table below records Muse's original handoff claims. Independent review
reproduced failures in activation, work claiming, fan-out and replica repair;
the original handoff is not acceptance evidence. The subsequent repair ledger
in REMEDIATION supersedes those claims. The isolated scale gate exposed a
48-product collection page checkpoint stall, now reproduced and fixed. The final
ordinary gate passed 525 tests in 78 files before a further incremental activation
refinement. The 100k build completed, but its edit gate failed (34 puts versus
10); a focused reproduction identified a commit-budget stall. Preparation and
activation now use separate bounded deliveries. The user selected focused checks
only on 2026-10-22: 33 current focused tests pass; the full ordinary and 100k
acceptance reruns are deferred. Final architecture acceptance remains pending;
see the current REMEDIATION evidence. Ordinary local D1 is now through 0011
under explicit user approval; remote state is unchanged.

| Requirements retained from plan                                                                                                                                                                                                       | Required evidence before closure                                                    | Status                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0010 coordinator lease/fence/expiry; parent/scoped build and captured source revision; exact pending references/retry/failure; immutable document mirrors and reference history                                                       | Fresh/upgrade/schema parity and fence races                                         | Implemented; disposable fresh + populated 0009→0010 tests pass; ordinary local application completed 2026-10-22                                       |
| Row-based child/listing progress; bounded cursor-only checkpoint JSON                                                                                                                                                                 | Large build checkpoint-size assertions                                              | Implemented (`catalog_build_listings`/`catalog_build_pages`/`catalog_ref_state` rows)                                                                 |
| One production unit per invocation across full, incremental, media, repair and cleanup; continuation enqueue before ACK; cron only wakes; no production full loop/test-driver imports                                                 | Actual Worker queue at 501 products, send failure and duplicate delivery            | Implemented; 501-product queue bootstrap regression passes; entrypoint queue test passes                                                              |
| Shared per-invocation ceilings: 40 D1 statements, 800 KV operations, 900 combined operations, 5000 source rows, 8 MiB serialized payloads, 90 binds; count batch statements and separate trigger work; bound queries before execution | Instrumented actual handler, quota documentation                                    | Implemented via `CatalogBudget`/`countedDb` pre-check counters; trigger work not separately metered (D1 exposes no local per-statement trigger count) |
| Targeted product/card source queries, product-page index patches, changed-product rule evaluation; resumable rule/membership/order scans and media keyset fan-out                                                                     | Mid-build mutations in every phase and shared-image fan-out                         | Implemented; `loadSourceContext` deleted; 95-product shared-image fan-out regression passes                                                           |
| Capture before reading; acknowledge only represented source revisions                                                                                                                                                                 | Interleaved edits remain due                                                        | Implemented (build `source_revision` captured at creation; work ack guarded by claimed revision)                                                      |
| Full serialized identity hashes; prepare immutable D1/KV artifacts; never infer KV presence from mirror; commit history/reference/delivery under lease/fence; guarded delivery and per-key timing; supersede obsolete work            | Stale publisher, partial writes, rapid references, missing directory despite mirror | Implemented; stale-lease guard abort regression passes; repair forces KV writes despite D1 mirrors                                                    |
| Independent reference verification and exact committed-artifact repair, including full/partial KV loss; rebuild derived catalog because historical 0008 copy is unproven                                                              | Products/slugs/layout/directories/pages/metadata/editorial recovery                 | Implemented; disposable corrupted-derived-pages rebuild through the queue publisher passes                                                            |
| Actual queue-driven 100k fixture with variants/images/manual and rule collections/tied timestamps; budgets reset only per real invocation                                                                                             | Isolated scale gate; paid-quota assumption explicit                                 | Original handoff claim superseded: independent 100k build completed, edit gate failed; focused repair passes; full rerun deferred                     |

Round 2 reader limitations below are closed by Round 3. Historical 0008 copy
verification remains unproven. Corrected source rebuilds on copied and ordinary
local persistence regenerated derived data through the actual Worker queue.

## Round 3: coherent readers — implemented, focused verification

| Requirement                                          | Implementation                                                                                                                                | Evidence / acceptance                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Pin counts, featured cards, pages and collection SEO | One listing reference; immutable directory and metadata key; exact historical D1 fallback                                                     | Pinned old payload/metadata, A→B→A and missing-reference regressions pass                                                        |
| Validate immutable boundaries                        | Schema, requested identity and full serialized hash; known missing artifacts fail visibly                                                     | Schema-shaped corruption of pages/directories/products/layout/editorial falls back exactly                                       |
| Product/editorial source isolation                   | Committed document mirrors only; no live product/editorial reconstruction                                                                     | Unpublished edits remain invisible on KV miss                                                                                    |
| Published navigation and home teasers                | Fixed layout: 8 navigation collections, 4 teasers, 3 posts                                                                                    | Actual browser navigation/teasers and zero-D1 HTML proof                                                                         |
| Complete collection/journal discovery                | Published index pages with persisted keyset cursors and revision restart                                                                      | 51 tied-title collections, exact D1 fallback, actual queue mutation during scan                                                  |
| Request-local promises                               | AsyncLocalStorage per fetch; sequential/concurrent reads share promises; independent requests do not share a TTL                              | Request-isolation and zero-D1 cold/warm tests pass                                                                               |
| Remove superseded readers/models                     | Deleted live product detail fallback, unused catalog-wide published query and write-only navigation model; readers no longer import publisher | Consumer search and typecheck; test-only driver stays in tests                                                                   |
| Bounded actual execution                             | Index scheduling and pending mutable-reference delivery participate in continuation completion                                                | Actual queue enforces 40 D1 / 800 KV / 900 combined / 5,000 rows / 90 binds; reference-drain regression passes                   |
| Migrations and integrity                             | Approved 0010 plus index-only 0011; historical SQL untouched                                                                                  | Local/fresh 239 objects, zero differences; FK clean; FTS works; stock ledger drift zero                                          |
| Actual public/private HTTP and browser               | Disposable state; no provider configured; additional runtime has no D1 binding                                                                | 8 public HTML routes succeed without D1; HTTP auth/2FA/permissions gate passes; cart hydration, pagination and bootstrap checked |
| Full architecture acceptance                         | Not asserted by this round                                                                                                                    | Full ordinary suite, isolated 100k and deployed gates deferred; Round 4 separate                                                 |

Current backup/log paths, native exit codes and unsuccessful attempts are in
REMEDIATION. The latest queue delivery correction has its own focused regression;
earlier passes are dated checkpoints, not silently relabeled current full gates.

## Round 4: reclamation - implemented, focused verification

| Requirement                                         | Implementation / actual evidence                                                                                                   | Status                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Before-images and migration safety                  | 346 source files hash-verified; stopped persistence copy 100 files including 24 WAL/SHM; manifests in REMEDIATION                  | Verified locally                                                                     |
| 0012 timestamps, indexes/cursors, durable lifecycle | Forward migration only; fresh/populated upgrade; local/fresh 267 schema objects, zero differences; FK/FTS/ledger checks            | Applied locally; no remote migration                                                 |
| Current/shared/history/staged protection            | Durable mark graph, retained history plus unreferenced grace; defer all nonterminal builds; exact directory validation             | Focused real-D1 cases pass                                                           |
| Fenced bounded work and deletion races              | One GC unit per existing queue delivery; source revision recheck; failed KV delete retains mirror/retry; list continuation counted | Actual queue/budget and failure-race cases pass                                      |
| Durable layout roots                                | Incremental layout commits reference/history before timed delivery                                                                 | Direct and actual-queue regressions pass                                             |
| Bounded retention and IP scrub                      | Stable indexed 1,000-row pages, released-only reservation pruning; financial/ledger preservation                                   | 1,001-IP boundary and populated upgrade pass                                         |
| Six-hour dead-webhook retry and staff replay        | Existing policy/guards unchanged; source inspected                                                                                 | No new provider or replay integration claim                                          |
| Gate honesty and docs                               | Focused native-exit runner; obsolete checkout load probe removed; all required docs updated                                        | Focused tests/lint/typecheck/drift/format/build pass; detailed reruns in REMEDIATION |
| Full ordinary suite and isolated scale gate         | Deliberately not run under latest focused-only instruction                                                                         | Deferred; final broad acceptance open                                                |
| Current public/private browser journeys             | Phase 3 evidence retained; Phase 4 changes no UI                                                                                   | Historical Phase-3 evidence; only service health repeated                            |

No original acceptance requirement has been silently removed. Historical 0008
copy verification remains unproven; corrected derived data rebuild evidence is
recorded above. Broad and deployed gates remain explicit rather than being
relabelled as current passes. This is the final implementation phase.

## External acceptance

Real Stripe behavior, supported-host Cache API hit/purge propagation, stale
visibility from already-started KV writes, sustainable deployed throughput and
production soak require separate authorization. Local stubs and Miniflare do not
close these gates. No claim of global exactly-once email delivery is made.

## Documentation basis

- [D1 batch rollback](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Stripe idempotency, cached failures and key retention](https://docs.stripe.com/api/idempotent_requests)
- [Cloudflare local persistence](https://developers.cloudflare.com/workers/development-testing/local-data/)

Context7 results were checked against installed Stripe 23.0.0 and Cloudflare
Vite plugin 1.64.0/Wrangler 4.151.1 source and types. Dependencies are unchanged.

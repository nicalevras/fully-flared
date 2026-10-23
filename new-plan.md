

\# Fully Flared architecture refactor



\## 1. Goal, decisions and operating boundaries



Replace the current whole-catalog read/publication model and non-idempotent checkout initiation with:



\- Small, independently published KV records.

\- Public HTML cached behind an uncached gateway.

\- One durable checkout intent per logical purchase attempt.

\- Atomic inventory reservations in the existing authoritative D1 database.

\- Recoverable Stripe operations and bounded background processing.

\- Measured checkout admission rather than uncontrolled database overload.



The implementation preserves the established storefront design, administration features, financial policies and security boundaries.



\### Decisions confirmed



\- \*\*Fresh database baseline:\*\* consolidate the development migration chain after verified backups, reset local D1 and reseed.

\- \*\*Remove the historical application:\*\* delete the obsolete root Hono app and old admin app; retain the root test/tooling setup.

\- \*\*Stop after every phase:\*\* each phase requires a review checkpoint before the next begins.

\- \*\*No commits, pushes, deployments, remote migrations, remote resource changes or real Stripe calls.\*\*

\- Retain installed dependency versions. Removing unused dependencies is permitted; upgrading retained dependencies is not.

\- Preserve D1 Time Travel recovery. Do not recreate the removed application-managed R2 backup system.



\### Commerce policies that remain unchanged



\- Browsing and adding to cart reserve nothing.

\- Checkout atomically reserves stock. The first successful reservation wins.

\- Payment commits inventory; cancellation and expiry release eligible holds.

\- Cart additions do not perform stock checks.

\- Availability loads once per page/navigation. No polling, focus refresh or refresh after adding to cart.

\- Unknown or failed availability leaves otherwise valid purchase controls enabled.

\- Backorders, shipping validation, supported currencies, tax configuration, coupon capacity, zero-total orders, late-payment refunds, dispute restrictions and restock restrictions remain enforced.



\### Starting point



The inspected working tree is clean at revision `64069d55d369c646969c3869198a1475408b9fbe`.



The maintained application is under `web/`. Its current migration chain ends at `0029\_return\_guards.sql`.



Observed issues informing this plan:



| Current implementation | Replacement |

|---|---|

| Whole catalog read and validation for ordinary pages | Product- and page-specific KV reads |

| Homepage independently loads the catalog twice | Request-scoped deduplication and explicit homepage data |

| Full catalog rebuild for catalog edits | Entity work records and affected-page publication |

| Snapshot search scans every product | Bounded D1 FTS search |

| New checkout identity on each submission | Durable client intent with database uniqueness |

| Stripe creation and attachment failures both cancel the order | Explicit definite-failure and uncertain-outcome recovery |

| Any cookie bypasses public HTML caching | Public rendering independent of private cart/session state |

| Catalog publication shares a queue with realtime broadcasts | Dedicated bounded catalog consumer |



No implementation or full-suite execution has occurred during this planning turn.



\---



\## 2. Architecture and integration contracts



\### 2.1 Runtime structure



Keep one Worker deployment with separate entrypoints:



```text

Default entrypoint: uncached gateway

&#x20; ├─ Public HTML GET → PublicStorefront entrypoint → Workers Cache

&#x20; │                                           └─ bounded KV reads

&#x20; │                                           └─ targeted D1 fallback

&#x20; ├─ Private/API/server-function requests → TanStack Start directly

&#x20; ├─ WebSocket → existing staff-only RealtimeDO

&#x20; ├─ Queue handler → typed background consumers

&#x20; └─ Scheduled handler → bounded recovery/discovery

```



The public entrypoint renders the same TanStack application using a sanitized public request. It does not introduce another hosting project or duplicate route tree.



Retain `src/server.ts` as the exported Worker surface. Extract gateway, public rendering, queue handling and scheduled handling into focused modules rather than growing that file further.



Use the installed Start server-entry API and generated Cloudflare types. Do not adopt examples from the skill’s older Vinxi/Nitro setup; that does not describe this installed application.



\### 2.2 Module ownership



Use domain-specific modules with direct dependencies, not generic repositories, service locators or a new dependency-injection framework.



| Subsystem | Responsibility |

|---|---|

| Checkout initiation | Intent ownership, canonical input, reservation orchestration, provider-operation claims |

| Payment transitions | Existing paid/cancel/refund/dispute business transitions |

| Payment provider | Stripe request construction, exact replay, retrieval and error classification |

| Catalog reads | Validated bounded KV reads and targeted fallback |

| Catalog publication | Change discovery, incremental projections, checkpoints and activation |

| Public rendering | Request sanitization, cache eligibility, cache tags and response policy |

| Background delivery | Typed queue messages, durable rows, retries and quarantine |

| Admission DO | Rate/concurrency permits only |

| Existing inventory/refund modules | Authoritative transactional commerce invariants |



Extract code when a new responsibility needs a boundary. Do not split stable helpers merely to reduce file length.



\### 2.3 Migration sequence



Consolidate the existing schema first, then use forward migrations between implementation checkpoints:



| Phase | Migration |

|---|---|

| 0 | `0000\_initial.sql` — current final schema and guards |

| 1 | `0001\_checkout\_intents.sql` |

| 2 | `0002\_checkout\_quote\_guards.sql` |

| 3 | `0003\_catalog\_read\_models.sql` |

| 4 | None |

| 5 | `0004\_checkout\_admission\_settings.sql` |

| 6 | None planned |



Every migration receives matching Drizzle metadata. Custom SQL remains explicit for FTS, triggers and transaction guards.



Once the new baseline is applied, do not repeatedly squash or rewrite it during later phases.



\---



\## 3. Phase 0 — Verified baseline and repository cleanup



\### 3.1 Preserve recoverable state



Before editing, create:



```text

C:\\Users\\nicka\\store-remediation-backups\\<UTC timestamp>\\architecture\\phase-0\\

```



Save:



\- Git revision, status and staged/unstaged binary diffs.

\- Before-images of tracked and relevant untracked source/configuration files.

\- A manifest containing relative paths and SHA-256 hashes.

\- The current migrations and metadata.

\- Existing local service command lines, process IDs, ports and persistence paths.



Before replacing local D1:



1\. Identify only this workspace’s dev/preview processes and runtime children.

2\. Stop those processes and verify their listening ports are released.

3\. Copy complete Wrangler persistence, including present WAL/SHM files.

4\. Compare source/copy SHA-256 manifests.

5\. Preserve local R2 media and secrets.

6\. Reset only the verified local D1 target after the backup checks pass.



Do not touch remote resources or unrelated processes.



\### 3.2 Establish baseline evidence



Run the existing full checks before deleting or restructuring code. Record failures and flakes; do not attribute pre-existing failures to the refactor or conceal them.



Capture baseline measurements for:



\- Checkout baskets containing 1, 3 and 50 distinct lines.

\- Coupon and non-coupon checkout.

\- Reservation and paid-transition statement counts.

\- Catalog read bytes and KV calls for home, product, collection and search.

\- Publication work after a single product edit.

\- Existing root/web dependency and build boundaries.



Instrumentation counts D1 binding calls, SQL statements and database timing separately.



\### 3.3 Remove the historical application



Remove obsolete runtime surfaces after confirming their references:



\- Root Hono `src/`.

\- Old `admin/` application.

\- Historical root Wrangler configuration and schema files.

\- Root initialization, seeding and D1-to-DO migration scripts belonging to that application.

\- Obsolete example integration files that exclusively target the removed API.

\- Hono, old Stripe and other runtime dependencies used only by those deleted applications.



Retain:



\- Root Vitest, ESLint and Prettier tooling.

\- Tests covering the maintained application.

\- Useful operational scripts under `web/scripts`.

\- Licensing and upstream attribution.



The root package becomes a tooling/orchestration package. Its `dev`, `build`, `typecheck` and related app commands delegate to `web` where appropriate. There must be one obvious deployment target.



Two observed legacy test consumers require explicit handling:



\- `tests/discounts.test.ts` imports the obsolete discount implementation.

\- `tests/helpers.test.ts` imports obsolete root utilities.



Move useful business assertions onto the maintained implementation; remove assertions for behavior that no longer exists. Do not preserve the historical runtime merely to keep its tests collecting.



Update CI, lint exclusions, ignore files and documentation. Remove the obsolete “historical application retained” instructions and mark the repo-hygiene proposal resolved.



\### 3.4 Consolidate the schema without losing protections



Build an isolated database through the existing `0000`–`0029` chain and inventory its final:



\- Tables and columns.

\- Foreign keys.

\- Indexes and partial unique indexes.

\- Trigger definitions.

\- FTS structures.

\- Seeded settings and operational rows.



Generate the new baseline from the current schema plus reviewed custom SQL. Compare its effective schema with the old chain’s final result.



Explicitly preserve:



\- Last-owner and protected-account guards.

\- Inventory/backorder guards and append-only ledger protections.

\- Checkout limits and currency locks.

\- Coupon and return/refund concurrency guards.

\- Media deletion/reference protections.

\- Notification uniqueness.

\- FTS synchronization.



Replace historical migration-path tests with fresh-baseline and direct invariant tests. Preserve their useful DML assertions. Rename or remove `restore-cli.test.ts` after moving its remaining relevant integrity assertions; it currently tests obsolete upgrade history rather than the supported Time Travel recovery path.



\### Phase 0 exit gate



\- Baseline checks recorded.

\- Clean installation of `0000\_initial.sql` passes schema, FK, FTS and business-guard checks.

\- Seed fixtures work with preserved local media.

\- Historical runtime/dependencies have no remaining active consumers.

\- Ordinary services are restored.

\- Backup paths and verified hashes are reported.

\- Stop with changes uncommitted.



\---



\## 4. Phase 1 — Durable checkout identity and Stripe recovery



\### 4.1 New persistence model



Add `checkout\_intents` with:



\- Client-generated UUID primary key.

\- Owner type: authenticated account or guest capability.

\- Account link or hashed guest capability identity.

\- Canonical request fingerprint.

\- Initiation lifecycle state.

\- Immutable provider-request payload and payload version.

\- Stable coupon and session idempotency keys.

\- Provider session ID/URL when known.

\- Operation claim token, claim deadline and fencing generation.

\- Frozen session expiry and hold expiry.

\- Retry/reconciliation timestamps and classified failure code.



Orders receive a unique checkout-intent relationship. Keep order fulfillment and payment status authoritative; do not duplicate them as another independently maintained financial state machine.



Intent states describe initiation:



```text

reserved → session\_creating → ready

&#x20;                        ↘ reconciliation\_required

reserved/session\_creating → canceled or expired, when safely established

```



Paid status is read from the order. A ready intent must not reopen a paid or terminal order.



Index intent ownership, provider identifiers and due recovery work.



\### 4.2 Ownership and canonical input



Keep `POST /api/checkout` as the external HTTP boundary. Add required `intentId`.



Canonical fingerprint input includes:



\- Merged, sorted SKU quantities.

\- Normalized email.

\- Country and selected shipping rate.

\- Normalized coupon code.



Exclude Turnstile tokens and other ephemeral fields.



For guests, use a separate random, HttpOnly capability cookie whose server-side representation is hashed. It survives clearing the cart cookie. Use `Secure` on HTTPS and preserve localhost development.



Never authorize access by email, order ID or intent ID alone.



Authenticated and guest retries must pass ownership checks before receiving session URLs. An ownership mismatch receives a generic response that does not reveal another shopper’s checkout.



\### 4.3 Atomic creation



For a new intent:



1\. Validate payment configuration and input.

2\. Apply abuse controls and Turnstile.

3\. Obtain a validated quote.

4\. Insert intent, order, items, coupon claim and reservations in one guarded D1 batch.

5\. Freeze the provider request in that same transaction.



Concurrent insert conflicts re-read the winning intent and verify ownership/fingerprint. They must not create another reservation or consume coupon capacity.



Maintain the existing configurable caps. A duplicate request does not consume another open-checkout allocation.



\### 4.4 Provider operation lifecycle



Refactor `payments.ts` so provider initiation is separately claimable and replayable.



Persist the exact parameters required for Stripe replay, including:



\- Currency and line amounts.

\- Tax codes and automatic-tax configuration.

\- Shipping amount/country.

\- Success/cancel URLs.

\- Session expiry.

\- Metadata and operation identities.



Retain the existing amount-off coupon strategy in this refactor. Do not simultaneously redesign discount presentation or tax calculation.



Coupon creation and session creation use separate stable keys. Store the coupon result before proceeding so recovery resumes the correct step.



Classify outcomes:



| Outcome | Behavior |

|---|---|

| Session created and attached | Return stored URL |

| Definite rejection with no provider operation created | Safely cancel and release |

| Timeout, connection loss or ambiguous provider failure | Persist recovery state; do not treat as definite cancellation |

| Session exists but attachment fails | Recover and attach that session |

| Another worker owns an active claim | Return pending status; do not call Stripe independently |

| Order already paid | Return existing order status |

| Replay no longer safe | Reconcile; never generate a fresh key for the same operation |



Use bounded provider timeouts and disable hidden automatic retries for initiation calls; application recovery owns replay.



Keep the existing fixed 23-hour refund-creation cutoff. For checkout creation, enforce both the idempotency safety horizon and the frozen Session expiration constraints. Do not blindly replay creation after its parameters are no longer valid.



\### 4.5 Guarded attachment and early webhook recovery



Replace the unconditional session attachment with a guarded update that verifies:



\- The expected intent/order relationship.

\- Expected operation identity.

\- No conflicting session already attached.

\- Eligible current state.



If the same session is already attached, replay succeeds harmlessly.



Extend the provider’s session representation and reconciliation paths with intent/order metadata and expiry/status information.



Verified webhooks arriving before attachment must resolve the matching durable intent using validated provider metadata, attach through the same guard and execute the normal business transition. An unresolved financial event remains recoverable; it must not be marked processed simply because no session mapping exists yet.



\### 4.6 Client integration



Create a focused checkout-intent client helper.



\- Store only intent ID and fingerprint in `sessionStorage`.

\- Preserve the same ID across double-clicks, network failures and manual retries.

\- Generate a new ID after material input changes or an explicitly terminal attempt.

\- Do not store email, provider payloads or capability secrets in browser storage.

\- Support `ready`, `pending`, `busy` and terminal error responses.

\- Retry buttons reuse the intent.

\- Keep retries user initiated in this version; add no persistent waiting room or background polling.

\- Redirect immediately when a valid URL is returned.



Return typed responses:



\- `200`: ready/existing completion.

\- `202`: initiation/reconciliation pending.

\- `409`: changed fingerprint, stale quote or commerce conflict.

\- `429`: admission/abuse capacity exhausted.

\- `503`: required dependency unavailable.

\- Generic `500`: unexpected internal failure.



Preserve existing cart-clearing cookies and best-effort cart conversion.



\### 4.7 Privacy and account lifecycle



Integrate new account links and frozen payloads with atomic account deletion and retention.



Deleting an account must retire its replay authorization and handle pending operations through guarded cancellation/recovery. Do not leave an additional copy of personal data indefinitely inside intent payloads or allow a deleted account’s intent to become guest-owned.



Never log frozen provider payloads, email addresses, guest tokens or Stripe credentials.



\### Phase 1 verification



Cover duplicate requests, cross-owner replay, changed fingerprints, worker crashes at each provider boundary, failed attachment, early webhooks, expired parameters, cookie clearing and account deletion.



Prove one logical intent yields one order, one stock allocation and one independently keyed session-creation operation.



Stop after the full phase checks pass.



\---



\## 5. Phase 2 — Reduce D1 work while preserving transactional correctness



\### 5.1 Request-scoped quote context



Reuse the existing quote server function and share its logic with submission.



Build a typed quote context containing:



\- Settings and limits.

\- Selected active product/variant data.

\- Shipping eligibility and calculated charges.

\- Coupon eligibility.

\- Currency and a commerce-configuration revision.



Read related quote data in a transactional D1 batch where consistency is required. Do not repeatedly call `getSettings` within one initiation.



Add a revision guard for checkout-relevant configuration changes. Product pricing/status, shipping, coupon configuration and applicable settings changes advance that revision; stock changes do not.



The reservation transaction rejects a quote whose authoritative revision changed. Stock and coupon capacity still receive their own transactional checks.



Do not silently increase the amount previously confirmed by the shopper. A stale quote returns updated pricing through the existing checkout display flow and requires resubmission.



\### 5.2 Set-based reservation writes



Replace per-item initiation writes with bounded, parameterized set-based statements using bound JSON input and SQLite `json\_each`.



Use the normalized, merged line array to:



\- Insert order items.

\- Conditionally update eligible stock rows.

\- Verify every required SKU was updated.

\- Insert reservations.

\- Insert ledger entries.



Keep all statements in one D1 batch. A cardinality/transition guard failure rolls back everything.



Preserve the existing transaction-identity protection. Never replace rollback with compensating stock updates or counter clamps.



Target initiation statement count independent of basket length, with \*\*no more than 25 explicit statements for the 50-line measurement fixture\*\*, excluding trigger execution. Report the actual count.



Profile paid commitment and recovery as well. Replace repeated per-SKU work with set-based operations over indexed order reservations/items where the same invariants can be maintained. Preserve guarded coupon recovery and once-only receipts.



\### 5.3 Query/index work



Use `EXPLAIN QUERY PLAN` and actual timings for:



\- Reservations by order/status/SKU.

\- Open-checkout caps by account/email/network/time.

\- Coupon claims by discount/customer/order.

\- Provider session and PaymentIntent resolution.

\- Due intent/inbox/outbox/refund work.



Add only indexes supported by these access patterns.



Keep statements below D1’s parameter limits. Do not confuse one batch call with one SQL operation or omit trigger cost from performance conclusions.



\### Phase 2 verification



Run existing inventory, checkout, coupon, refund, currency and race regressions.



Compare 1-, 3- and 50-line baskets against Phase 0, including mixed payment processing. Require lower large-basket database work without ledger drift, oversells or weakened validation.



Stop at the review checkpoint.



\---



\## 6. Phase 3 — Partitioned catalog and incremental publication



This phase replaces both catalog reads and their writer. Do not introduce partitioned readers while retaining a full-catalog publisher as the final implementation.



\### 6.1 Read models



Create explicit Zod-validated contracts:



| Model | Contents |

|---|---|

| Product document | One product, active variants, media and SEO; no inventory counters |

| Listing page | Complete cards for one bounded page |

| Listing metadata | Generation, count, page size and page count |

| Layout/home content | Public settings, featured product/card, first four homepage collections and recent post previews |

| Navigation | Compact collection links in bounded chunks |

| Editorial document | One published page/post where needed by public rendering |



Preserve homepage page size 24 and collection page size 48.



Cards contain fields needed by cards, not full descriptions or every variant.



Use a versioned key namespace, for example:



```text

catalog:r1:slug:product:<slug>

catalog:r1:product:<id>:<revision>

catalog:r1:listing:<id>:current

catalog:r1:listing:<id>:<generation>:page:<number>:current

catalog:r1:listing:<id>:<generation>:page:<number>:<revision>

catalog:r1:layout:current

catalog:r1:layout:<revision>

```



Listing `all` represents homepage “Shop all.”



Mutable references remain small. Immutable values carry schema version and identity/revision information. There is no global manifest or catalog-wide pointer on the request path.



\### 6.2 D1 publication structures



Replace the singleton publication model with:



\- Entity work rows: target revision, processed revision, build token, checkpoint, retry state and reference-write timing.

\- Materialized product-card projection.

\- Materialized collection membership.

\- Listing generations and page payloads.

\- Product-to-page lookup rows.

\- Pending scoped cache invalidations.



The product-to-page index identifies exactly which active pages contain a changed card.



Persist bounded page payloads in D1 as the publication source and exact fallback. This deliberately duplicates derived data so a KV miss does not require rescanning or deeply offsetting the source catalog.



Index:



\- Work by due state.

\- Membership by listing and stable product ordering.

\- Pages by listing/generation/page number.

\- Page membership by product.

\- Cleanup candidates by retired generation/time.



\### 6.3 Change capture



Replace the old dirty triggers with entity-specific work capture.



\- Product/variant/media changes mark relevant product or media work.

\- Collection edits mark collection work.

\- Editorial changes mark relevant document/layout work.

\- Only actual changes to published settings mark layout work.

\- Stock, reservations, payments and `currency\_locked` do not dirty catalog publication.



Capture work transactionally with source changes. Queue delivery is a wake-up mechanism, not the only record that publication is required.



Remove the broad `CATALOG\_ACTIONS` rebuild heuristic from `adminFns.ts`. Successful mutations enqueue the affected work identities; cron finds durable work when enqueueing fails.



Media fan-out and rule evaluation are checkpointed. Do not perform an unbounded cascade through application loops inside an admin request.



\### 6.4 Incremental page strategy



Use two distinct operations:



\*\*Card-only change, membership/order unchanged\*\*



\- Rebuild the product document.

\- Find containing active pages through the product-to-page index.

\- Patch those bounded page payloads.

\- Publish new immutable page revisions and update their references.



\*\*Membership or ordering change\*\*



\- Build a new affected listing generation using keyset iteration.

\- Preserve `created\_at DESC, id DESC` ordering.

\- Assemble 24/48-card pages in bounded work units.

\- Activate the listing generation only after its pages are durable and publication steps complete.



A new product may genuinely shift many numbered pages. That work is allowed, but remains checkpointed and limited to affected listings. It must not rewrite unrelated product documents.



Rule collections retain current price and literal-title rules. Evaluate membership changes in bounded background work. A rule edit may require a full affected-collection evaluation; do not claim constant work for arbitrary substring rules.



\### 6.5 Concurrency and KV consistency



\- One catalog consumer processes publication work sequentially.

\- Each step has a build token and revision check.

\- Edits during publication remain dirty.

\- Page patches cannot overwrite a newer listing generation.

\- Retry writes are idempotent.

\- Persist reference-write timing and coalesce repeated writes to the same KV key.

\- Requeue continuation work instead of sleeping through long rebuilds.

\- Keep old immutable generations available for seven days, then clean them in bounded pages.



Readers validate references and payloads. Missing, corrupt or mismatched data triggers targeted D1 fallback.



A listing response uses one generation for metadata and pages. Do not combine a count from one generation with page contents from another.



Publication is eventually consistent. Do not claim globally atomic multi-key KV activation or a hard global visibility deadline.



\### 6.6 Read-path integration



Replace current snapshot consumers:



\- Homepage requests layout/home metadata plus one listing page.

\- Product routes resolve a slug and one product document.

\- Collection routes request metadata and one page.

\- Search uses FTS.

\- Root layout reads only public layout/navigation data.



Use a request-scoped promise map to deduplicate repeated reads from loaders, SEO and nested layouts. Do not use a process-global map containing the full catalog.



Target normal catalog SSR at no more than ten KV operations, independent of product count, and zero D1 calls when required KV records are healthy.



Preserve numbered public pagination URLs.



Navigation links use bounded chunks with a “more” interaction when necessary; do not silently discard collection links or load all collection descriptions into the root layout.



\### 6.7 Search



Use the current FTS infrastructure with active-product filtering and deterministic ranking/tiebreakers.



\- Return at most 50 results plus continuation information.

\- Add a validated cursor for subsequent results.

\- Avoid deep `OFFSET`.

\- Do not calculate an expensive exact total merely to display search results.

\- Document tokenized FTS semantics; retain literal substring semantics for collection rules.



\### 6.8 Remove superseded code



After all consumers switch:



\- Delete whole-catalog snapshot types, builders and schema validators.

\- Delete `catalog:vN`, `layout:vN` and `catalog:current` readers/writers.

\- Delete oversized-snapshot sentinel handling.

\- Delete the 500-product fallback snapshot and its memo.

\- Delete full-snapshot search/filtering.

\- Delete `updateCatalogProduct` behavior that rebuilds everything.

\- Replace snapshot-specific tests with behavioral publication/read tests.

\- Retain inventory-aware admin/cart queries separately from published catalog types.



\### Phase 3 verification



Use a deterministic 100,000-product fixture with variants, images, manual/rule collections and tied timestamps.



Prove:



\- Complete pagination and stable counts.

\- Bounded per-request reads and bytes.

\- No full-catalog materialization on ordinary HTTP requests.

\- Card-only edits update affected pages without a global rebuild.

\- Membership changes resume across jobs.

\- Both race orders around generation activation are safe.

\- Missing/stale KV values fall back without truncation.

\- Interrupted publication resumes.

\- Stock changes produce no publication work.

\- Scheduled posts still publish when due.



Stop at the review checkpoint.



\---



\## 7. Phase 4 — Public/private rendering and Workers Cache



\### 7.1 Gateway classification



The default entrypoint remains uncached.



Only ordinary public HTML GET requests enter `PublicStorefront`. Exclude:



\- APIs and server-function transport.

\- Auth, account, admin, cart and checkout.

\- WebSockets.

\- Non-HTML requests and framework-specific transport requests.

\- Unsupported methods.



Normalize only known irrelevant tracking parameters. Preserve parameters affecting rendered content, especially pagination and search.



Include validated origin/store identity in cache partitioning. Workers Cache does not automatically partition by hostname.



Strip private cookies and authorization before forwarding public rendering. Strip or normalize untrusted forwarding/override headers that could change URLs or cache identity.



Apply security headers consistently on hits and misses.



\### 7.2 Remove private data from public SSR



Refactor the root layout:



\- Public layout loader returns public store data only.

\- Cached HTML contains a neutral cart badge.

\- A private GET server function returns the guest/account cart count.

\- Browser requests that private state once after hydration.

\- Existing cart mutation events keep the badge current.

\- Drawer contents continue loading privately when opened.



Do not introduce a new public REST endpoint for this internal application call.



The same public page must render identical private-data-free HTML for anonymous shoppers, guests with carts and signed-in shoppers.



Keep private pages fully authenticated on the server.



\### 7.3 Cache policy



\- Disable cache on the default entrypoint.

\- Enable it on `PublicStorefront`.

\- Keep cross-version cache reuse disabled.

\- Cache successful public HTML with a 60-second shared TTL.

\- Use browser revalidation rather than a long browser freshness window.

\- Keep private, error and Set-Cookie responses uncacheable.

\- Leave search uncached initially because arbitrary queries can create excessive cache cardinality and source reads.



Tag responses by affected product, listing, editorial document and shared layout.



Purge through an RPC method on `PublicStorefront` itself: Cloudflare scopes programmatic purges to the cache-owning entrypoint. Purging from the uncached gateway alone would target the wrong cache.



Persist failed invalidations for retry. TTL remains the fallback. KV propagation can still cause briefly stale refills; document this rather than claiming immediate global freshness.



Retain the separate five-second availability Cache API. Remove the old HTML Cache API wrapper and publication-version cache keys once Workers Cache integration is verified locally.



\### Phase 4 verification



\- Cache/private isolation across cookies, users, hosts and query parameters.

\- No identity, cart count, order information or private loader data in public HTML or hydration payloads.

\- Correct cart hydration and mutation updates.

\- Correct redirects, CSP, Set-Cookie handling and server-function behavior.

\- Purges execute in the owning entrypoint.

\- Production build exports the named entrypoint.

\- Local tests validate policy; actual edge hits and tiered behavior remain a deployment acceptance gate.



Stop at the review checkpoint.



\---



\## 8. Phase 5 — Admission control and bounded consumers



\### 8.1 Checkout admission DO



Add one SQLite `CheckoutAdmissionDO` per store.



Its synchronous storage transaction manages:



\- Rate tokens.

\- Burst allowance.

\- Active permit records.

\- Permit IDs and deadlines.

\- Idempotent release.

\- Expired-permit cleanup.



No D1 or Stripe request occurs inside a DO storage transaction.



Initial admin-editable settings:



| Setting | Default | Validation |

|---|---:|---|

| Checkout starts/second | 5 | Integer 1–100 |

| Burst allowance | 10 | Integer 1–200 |

| Active initiations | 10 | Integer 1–200 |



These are conservative starting budgets, not measured capacity claims. Enforce bounds in Zod and SQL setting guards. Missing rows use defaults.



The DO refreshes configuration at most once per minute with a shared in-flight read. Failed refreshes cannot silently permit unlimited traffic.



\### 8.2 Request ordering



For checkout:



1\. Validate input/configuration and apply abuse controls.

2\. Resolve owned intent.

3\. Return ready/terminal/in-progress replay without consuming new-start capacity.

4\. Acquire admission for new initialization or provider recovery work.

5\. Perform guarded database/provider work.

6\. Release in `finally`.



Capacity exhaustion returns `429 CHECKOUT\_BUSY` with `Retry-After`.



Controller/storage failure returns `503 CHECKOUT\_UNAVAILABLE`.



Denied requests create no order, reserve no inventory and call no Stripe API.



\### 8.3 Lease and deadline semantics



\- Permit lifetime: 120 seconds.

\- Initiation orchestration deadline: 30 seconds.

\- Individual provider-call timeout: 10 seconds.

\- Provider initiation uses no hidden SDK retry loop.

\- Check deadlines before starting each external operation.

\- D1 claim generations fence stale local transitions.

\- Expired claims enter recovery using the same provider operation identity.



Lease expiry restores capacity after crashes. It does not prove Stripe stopped processing an already-sent request. Document the controller as bounding admitted initialization work, not enforcing an exact global count of Stripe’s internal processing.



\### 8.4 Queue separation



Use:



| Binding | Responsibility | Initial consumer settings |

|---|---|---|

| `JOBS` | Financial inbox and checkout recovery | Batch 1, concurrency 2 |

| `NOTIFICATIONS` | Durable email/outbox delivery | Batch 10, concurrency 2 |

| `CATALOG\_JOBS` | Publication and scoped invalidation | Batch 1, concurrency 1 |

| Shared DLQ | Durable failure classification/alerts | Batch 10, concurrency 1 |



Replace `JOBS\_RT`. Realtime broadcasts are best-effort after durable transitions/publication and do not share the catalog work queue.



Mirror every binding/configuration in the isolated preview environment.



Move queue message types out of `email.ts` into one shared typed schema/module. Remove duplicate unions and obsolete message variants.



\### Phase 5 verification



Test simultaneous acquire/release, duplicate releases, DO restart, alarm cleanup, controller failure, stale settings, timeouts and recovery after lease expiry.



Run bursts up to 1,000 arrivals with stubbed providers. Assert admitted/completed/rejected counts separately and verify zero duplicate stock allocation.



Exercise mixed payment, cart, auth and maintenance workloads while admission is saturated.



Stop at the review checkpoint.



\---



\## 9. Phase 6 — Recovery, retention, observability and final acceptance



\### 9.1 Durable webhook and notification delivery



After signature verification:



1\. Persist the inbox event.

2\. Enqueue processing.

3\. Acknowledge once persistence is durable.



Remove full inline financial processing on queue-send failure. Durable cron recovery handles enqueue failures.



\- D1 persistence failure must not acknowledge successful delivery.

\- Unsupported event types remain explicitly ignored.

\- Financial events are processed only after their business result or recovery operation is durable.

\- Exhausted/poison events enter durable quarantine with deduplicated alerts.

\- Add guarded staff replay for quarantined events using the original event identity.

\- Preserve existing transactional outbox insertion and immediate enqueue after commit.

\- Preserve email delivery claims and retry limits.



Do not describe email transport as exactly once.



\### 9.2 Bounded scheduled work



Retain the existing cron architecture. Add no generic maintenance framework or replacement scheduler.



\- Keep explicit limits and saved cursors for each sweep.

\- Limit simultaneous maintenance tasks instead of launching every database-heavy task together.

\- Count combined D1 work in regressions.

\- Make intent recovery, catalog recovery and invalidation retries bounded.

\- Retention deletes disposable records in fixed-size pages.

\- Preserve committed reservations, financial records and ledger history.

\- Keep unresolved intents and financial events recoverable.

\- Scrub eligible terminal intent payloads and expired guest identities under documented retention.



Scheduled posts remain a required regression.



\### 9.3 Observability



Emit structured, PII-free events for:



\- Checkout replay/conflict and provider uncertainty.

\- Admission grant/rejection/failure.

\- Database timing and statement counts in benchmark instrumentation.

\- Publication backlog, age, progress and failed references.

\- KV fallback and invalid payloads.

\- Cache invalidation failure.

\- Inbox/outbox quarantine and recovery.

\- Database growth and invariant mismatches.



Do not write per-public-request analytics into D1. Use existing Workers observability; no additional analytics product is required for this refactor.



\### 9.4 Recovery documentation



Preserve Time Travel as the supported database recovery mechanism.



Document the derived-data consequence of a future restore: KV and cached HTML are not restored with D1. Before reopening writes after recovery, republish derived catalog state and purge public cache.



Do not add automated SQL-to-R2 backups, promise unsupported import restoration or run remote recovery commands during implementation.



\### 9.5 Final dead-code pass



Remove:



\- Compatibility readers/writers for replaced development models.

\- Old snapshot keys, sentinels and global version APIs.

\- Duplicate checkout/provider request construction.

\- Obsolete queue producers and consumers.

\- Unused root dependencies and deployment paths.

\- Stale backup bindings/scripts/comments.

\- Dead simulated-checkout response fields.

\- Tests that assert removed source spelling rather than behavior.

\- Temporary probes and benchmark fixtures outside the maintained harness.



Preserve useful business regressions. No test is removed merely because it fails.



\### Phase 6 exit gate



Fresh installation, complete test suite, browser journeys and representative local stress tests pass. Documentation states what is implemented, verified locally and still awaiting deployment verification.



Stop uncommitted.



\---



\## 10. Verification commands, evidence and acceptance



\### Checks at every phase



From `C:\\Users\\nicka\\store`:



```powershell

npm test

npm run lint

npm run typecheck

npm run format:check

git diff --check

```



From `C:\\Users\\nicka\\store\\web`:



```powershell

npm run cf-typegen

npm run typecheck

npm run build

node node\_modules/wrangler/bin/wrangler.js types --check

npm run check:migrations

```



Run focused behavioral regressions before the full phase gate. Capture a failing result before fixing a reproduced defect where applicable.



Update migration checks to validate:



\- Current metadata/schema agreement.

\- Required custom guards and FTS structures.

\- Fresh installation.

\- Populated forward upgrades from each new checkpoint.

\- No accidental table reconstruction in forward migrations.



Run HTTP/browser checks against disposable copied state, including:



\- Guest/account checkout and retry.

\- Last-item contention and backorders.

\- Zero-total orders.

\- Shipping, coupons and currency races.

\- Private/public cache separation.

\- Cart badge hydration and drawer behavior.

\- Homepage/collection pagination and search.

\- Admin permissions, media handling and account deletion.



Use stubbed providers throughout local execution.



\### Performance acceptance



| Scenario | Required evidence |

|---|---|

| 100,000 products | Complete bounded publication, browsing and updates |

| Healthy catalog SSR | Zero D1 calls; bounded KV reads independent of catalog size |

| 50-line initiation | At most 25 explicit SQL statements, with trigger work reported separately |

| Typical checkout | Target 25 completed initiations/second under a realistic mixed workload |

| Burst arrivals | 1,000 attempts admitted, pending or safely rejected without duplicate allocation |

| Inventory | Zero oversells or unexplained ledger drift |

| Provider uncertainty | No independently keyed replacement operation for the same intent |

| Public caching | No private data leakage; scoped invalidation |

| Deployed browsing | Target 10,000 predominantly cached requests/second, pending authorized deployed measurement |



Performance targets are not presumed capabilities. Record offered traffic, admission, completion, rejection, latency percentiles, database timing, errors and costs separately.



\### Phase report



At every stop, update `REMEDIATION.md` and provide:



\- Requirement → implementation → regression → actual result.

\- Diff and deletion summary.

\- Exact command exit codes and log locations.

\- Migration names and local application results.

\- Verified backup paths/hashes.

\- Restored services and ports.

\- Remaining risks and deployment-only checks.

\- Git status confirming changes remain uncommitted.



Update README, LAUNCH, SCALING and DECISIONS as their corresponding behavior changes. Historical evidence remains labeled historical.



\### Documentation basis



Use current documentation retrieved through Context7 and verify exact signatures against installed types/source:



\- \[D1 transactional batches](https://developers.cloudflare.com/d1/worker-api/d1-database/).

\- \[D1 platform limits](https://developers.cloudflare.com/d1/platform/limits/).

\- \[KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

\- \[Workers Cache configuration](https://developers.cloudflare.com/workers/cache/configuration/).

\- \[Workers Cache entrypoint examples](https://developers.cloudflare.com/workers/cache/examples/), including entrypoint-scoped purging.

\- \[SQLite Durable Object transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

\- \[TanStack Start server entry](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point).

\- \[Stripe idempotent requests](https://docs.stripe.com/api/idempotent\_requests).



Local checks cannot establish deployed cache behavior, actual provider throughput or sustainable production checkout capacity. Those remain explicit external acceptance gates requiring separate authorization.






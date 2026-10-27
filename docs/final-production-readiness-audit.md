# FULLY FLARED: FINAL PRODUCTION READINESS AUDIT

Investigation date: 2026-10-27. Repository: nicalevras/fully-flared. This report is an investigation deliverable only. No application code was changed for production. All integration work happened in a disposable local candidate that was never pushed.

## A. Executive verdict

**Verdict: NO-GO for merging the stack today. A short, named path to CONDITIONAL GO exists in Section M.**

Overall code quality assessment: good within each PR. The overnight PRs are small, reuse existing actions and components, and carry real tests. The weakness is not inside individual PRs. The weakness is that the PRs were only ever verified one at a time, and two separately green branches contradict each other when combined.

Architecture assessment: sound and unchanged. D1 stays authoritative, the stock ledger stays append-only, Stripe and publisher behavior are reused rather than rebuilt, and no new infrastructure was introduced. Nothing in this audit recommends a platform redesign.

Correctness and security assessment: mixed. Commerce invariants held everywhere they were tested. Three correctness problems are confirmed: the integrated tree fails its own Phase 19 invariant, media reordering has no real concurrency guard, and the returns queue silently stops at 50 open returns. One privacy problem is confirmed: guest erasure does not cover every store of the email it claims to erase, and no record shows the owner ever approved the erasure contract.

Test coverage confidence: moderate. The integrated candidate passes 813 of 816 tests. The one failure is the confirmed integration regression. Confidence is limited by two facts: interactive browser verification could not run in this host, and one catalog test file fails in isolation on unmodified `main` as well as on the stack, so the suite has a known trust defect.

Five most consequential findings:

1. FF-01. The combined tree fails `tests/audit-19.test.ts` because PR #44 reintroduced `window.confirm` into an admin route that PR #42 forbids. Reproduced on the integrated candidate.
2. FF-02. Guest erasure leaves the guest email in notification outbox payloads, replaces the address with a guessable deterministic digest, and has no documented owner approval. It must be withheld from the release (locked owner decision).
3. FF-03. The returns view returns at most 50 open returns with no way to page further. Measured: 55 seeded returns produced 50 rows.
4. FF-04. Competing media reorders both succeed and the second silently wins. Measured at the server action level.
5. FF-08 and FF-16. Audit rows are written after business mutations across roughly 30 admin actions. An audit failure reports an error after the change already committed, and replaying an inventory adjustment writes additional audit rows.

## B. Verified repository and PR state

Measured on 2026-10-27 after fetching all remotes. There is no drift from the state recorded when this investigation was commissioned.

- `main`: `982d12ccae2947dbf694d41752ef513a40fa1aea` (Merge pull request #14).
- Closed without merging: PR #15 (`6bd1697`, Phase 3A) and PR #16 (`a6fcffa`, Phase 3B). Superseded by PR #44.
- PR #44: OPEN, `codex/admin-product-creation-3ab`, head `6f9373b`. It contains the original #15 and #16 commits as ancestors, with six remediation commits on top. It is not an independent rewrite.
- Open stack, all targeting `main`: PR #17 `215d8d9`, #18 `f41edf6`, #19 `c8092a8`, #20 `bef3d11`, #21 `0d081f5`, #22 `80f1d7f`, #23 `be16d55`, #24 `a833cea`, #25 `01e0810`, #26 `535fe84`, #27 `b5d7c2e`, #28 `a779db1`, #29 `54a44c8`, #30 `afd1dc8`, #31 `560202b`, #32 `af024d8`, #33 `2f3ded3`, #34 `e54672e`, #35 `a6712e7`, #36 `624d631`, #37 `76d2c8c`, #38 `ed95f77`, #39 `1ab7347`, #40 `8243fd0`, #42 `c1a21db`.
- Open issues: #41 (Phase 19 follow-ups) and #43 (audit atomicity and hardcoded currency labels).
- The merge base of PR #44 and PR #17 is `a6fcffa`, the original Phase 3B head. Every later PR descends from the original #15 and #16 commits, not from PR #44's remediation commits.

Integration candidate. A disposable worktree was started at the PR #44 head and merged with each branch in stack order, PR #17 through #40 then #42, using merge commits that mirror the owner merging PR #44 first and then each PR bottom-up. The candidate was never pushed and no existing branch was changed.

Conflict log:

- PRs #17, #18, #19, #20 merged clean.
- PR #21 (Phase 5B) conflicted in `web/src/routes/admin/products/index.tsx`. PR #44 side carried the role-gated Add product link preserving list search state and a CSV paste import form. PR #21 side carried the Import CSV page link and an ungated Add product link. Candidate resolution kept the Import CSV link, kept PR #44's gated link with list state, and dropped the paste import form together with its now-unused state, matching PR #21's stated intent to replace the paste-first workflow. This resolution is recorded as finding FF-14 because the merged result removes a feature PR #44 deliberately retained, and the owner should confirm that removal is the intended final state.
- PRs #22 through #40 and #42 merged clean after that single resolution.
- One candidate-only commit dropped dead CSV state left behind by the merge. It exists only in the disposable candidate.

First reproduction, run before trusting anything else: `tests/audit-19.test.ts` on the candidate failed with exactly one offender, `web/src/routes/admin/products/new.tsx`. That is FF-01, reproduced.

Gates on the final candidate, in order: 20 focused cluster test files passed (68 tests) covering product editing, media, import, inventory, order discovery, shipment, workspace, guest data, customers, blog, draft recovery, discounts, shipping, collections, global search, dashboard, and report reconciliation. PR #44's own creation suites passed (21 tests). Lint passed. Format check passed. Typecheck passed after generating Worker types in the fresh worktree. `check:migrations` passed. A fresh build passed and `check:bundle` passed against it: client JS 1,288,863 B in 82 chunks, server startup 3,172,269 B in 41 modules. The full suite ran 816 tests: 813 passed, 2 skipped, 1 failed. The single failure is FF-01. Local HTTP checks against the candidate returned 200 at the sign-in boundary for `/admin`, `/admin/products`, `/admin/products/new`, `/admin/orders`, `/admin/customers`, `/admin/blog`, `/admin/settings`, and `/admin/reports`. Those are unauthenticated boundary checks, not authenticated interaction.

Safe consolidation strategy (stack shape preserved, per owner decision):

1. Land the remediation PR for FF-01 onto PR #44's branch first, so the creation page uses the shared `ConfirmDialog`. Update PR #44 and re-read its live CI.
2. Merge PR #44 into `main`. Run the Phase 19 audit test, the PR #44 creation suites, and the full suite on `main`.
3. Merge each PR from #17 to #42 in numeric order. After each merge, re-read live CI. The risky merges needing a human watching are #21 (products page, the FF-14 decision), #29 (known formatting history), and #42 (its audit test only passes once step 1 has landed).
4. No rebase of the stack is required if PR #44 merges as a merge commit, because the later branches already contain the original #15 and #16 commits that PR #44 carries. If the owner squashes PR #44 instead, every later branch must be rebased and this strategy must be re-derived. Do not squash PR #44.

## C. Original roadmap reconciliation

| Phase                  | Requirement                                           | Implemented?                | Verified?                                                         | Deviations                                                                                                | Finding IDs  | Decision                              |
| ---------------------- | ----------------------------------------------------- | --------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------- |
| 3A/3B (PR #44)         | Product creation workspace, variant generation        | Yes                         | Yes, server and database level suites pass on the candidate       | Persistent option groups not stored; creation page reintroduces `window.confirm`                          | FF-01, FF-17 | Owner decision on options (Section K) |
| 4A (PR #17)            | Reviewed save, revision conflicts, timestamp contract | Yes                         | Focused suite passes; SPA navigation guard is `beforeunload` only | Internal navigation while dirty is not blocked                                                            | FF-12        | Remediate in R6 or accept             |
| 4B (PR #18)            | Rich descriptions                                     | Yes                         | Focused suites pass                                               | Storefront rendering not browser-verified                                                                 | none         | Verify in browser pass                |
| 4C (PR #19)            | Bulk price edits under checkout contract              | Yes                         | Focused suites pass                                               | Prepared quote and Stripe session behavior not re-verified in this audit                                  | FF-20        | Verify before deployment              |
| 5A (PR #20)            | Media ordering and attach                             | Yes                         | Focused suite passes                                              | Reorder has no ordering-conflict guard                                                                    | FF-04        | Remediate in R4                       |
| 5B (PR #21)            | CSV import page                                       | Yes                         | Focused suites pass                                               | Combined tree drops the paste form PR #44 retained                                                        | FF-14        | Owner confirms final state            |
| 6A/6B (PRs #22, #23)   | Inventory adjustments with replay protection          | Yes                         | Focused suites pass                                               | Audit row written after the atomic stock batch; replay adds audit rows                                    | FF-08        | Remediate in R5                       |
| 7 (PR #24)             | Order discovery and queue                             | Yes                         | Focused suite passes                                              | Returns view capped at 50 with no continuation                                                            | FF-03        | Remediate in R3                       |
| 8A (PR #25)            | Order workspace, packing slip                         | Yes                         | Focused suite passes                                              | Packing slip print isolation unverified                                                                   | FF-10        | Verify, then remediate CSS if needed  |
| 8B (PR #26)            | Shipment and refund interaction                       | Yes                         | Focused suite passes                                              | Browser behavior unverified                                                                               | none         | Verify in browser pass                |
| 9 (PR #27)             | Bulk fulfillment                                      | Yes                         | Focused suite passes                                              | Browser behavior unverified                                                                               | none         | Verify in browser pass                |
| 10A (PR #28)           | Privacy contract, contact lookup                      | Yes                         | Focused suite passes                                              | Contract was adopted under agent defaults; no owner approval record                                       | FF-02        | Withhold erasure (locked)             |
| 10B (PR #29)           | Customer workspace                                    | Yes                         | Focused suite passes                                              | First CI run failed on formatting; fixed and recorded                                                     | none         | None                                  |
| 10C (PR #30)           | Guest export and erasure                              | Export yes; erasure partial | Focused suite passes                                              | Erasure misses outbox email copies; digest is guessable; export caps at 200 orders with a truncation flag | FF-02        | Withhold erasure (locked)             |
| 11A/11B (PRs #31, #32) | Blog and Pages editors                                | Yes                         | Focused suites pass                                               | No server concurrency guard on save                                                                       | FF-07        | Remediate in R4                       |
| 12 (PR #33)            | Device draft recovery                                 | Yes                         | Memory-store tests pass                                           | Real IndexedDB race unproven either way; browser unavailable                                              | FF-06        | Verify before deployment              |
| 13 (PR #34)            | Collections product search                            | Yes                         | Focused suite passes                                              | Membership read cost at many collections is source-derived only                                           | none         | Measure if collections grow           |
| 14 (PR #35)            | Discount search and editing                           | Yes                         | Focused suite passes                                              | Edit mode clears after a failed update                                                                    | FF-05        | Remediate in R6                       |
| 15 (PR #36)            | Shipping readability, rate delete, sample quote       | Yes                         | Focused suite passes                                              | Sample quote server function has no permission check beyond staff authentication                          | FF-11        | Remediate in R6                       |
| 16 (PR #37)            | Settings grouping, setup checklist                    | Yes                         | Focused suite passes                                              | None confirmed                                                                                            | none         | None                                  |
| 17A (PR #38)           | Date-correct dashboard                                | Yes                         | Focused suite passes                                              | UTC boundaries; no store timezone exists                                                                  | FF-18        | Owner decision (Section K)            |
| 17B (PR #39)           | Report and export reconciliation                      | Yes                         | Reconciliation test passes on candidate                           | None confirmed                                                                                            | none         | None                                  |
| 18 (PR #40)            | Global search                                         | Yes                         | Focused suite passes                                              | Customer email query plan uses a UNION with temporary B-trees; no mobile trigger                          | FF-09, FF-19 | Measure at scale; remediate in R7     |
| 19 (PR #42)            | Final consistency audit                               | Yes                         | Its invariant fails on the combined tree                          | The audit was per-branch, so the cross-PR regression escaped it                                           | FF-01        | Remediate in R1                       |

## D. Confirmed defects

Severity follows the brief: P0 release blocking, P1 must resolve before general production release, P2 deferrable only with explicit owner acceptance, P3 polish.

**FF-01, P0, integration, PR #44 with PR #42.** PR #44's product creation page confirms edited-combination loss with `window.confirm` (`web/src/routes/admin/products/new.tsx`, line 96 on that branch). PR #42 added `tests/audit-19.test.ts`, which forbids `window.confirm` in every admin route. Each branch passed CI alone. On the integrated candidate the test fails with that single offender, and it is the only failure in 816 tests. Impact: the stack cannot merge in any order without either failing CI on `main` or weakening the Phase 19 invariant. Smallest remediation: replace the native confirm with the shared `ConfirmDialog`, preserving the pending option change exactly as the native flow does. Blocks merging.

**FF-02, P0 for the erasure feature, privacy, PRs #28 to #30.** Guest erasure updates only the `orders` row: email replaced, shipping name, shipping address, and IP cleared (`web/src/server/guest-data.ts`, `eraseGuestData`). Measured reproduction on the candidate: after erasing a seeded guest, the order row was cleaned, but a seeded outbox row still contained the guest email in `payload_json`. Shipment and notification payloads are written from the order email at ship time, so real stores will hold the same copy. Three further defects compound it. The replacement address is `erased-<first 24 hex chars of SHA-256(email)>@erased.invalid`; anyone who guesses the email can recompute and confirm the digest, so it is pseudonymous, not anonymized, and the UI must not claim otherwise. The preview lists at most 50 orders while the count is exact, and export caps at 200 orders with a truncation flag, so a large guest history is never shown in full before a destructive action. No document, PR body, or comment records explicit owner approval of the retention contract; the contract in `docs/admin-customers/README.md` was written by the agent under delegated defaults in PR #28. Impact: shipping erasure as-is would make a privacy promise the code does not keep. Locked owner decision: withhold erasure from the release. Blocks the erasure feature only, not the rest of the stack, once withholding is actually implemented (remediation R2).

**FF-03, P1, correctness, PR #24.** The returns view loads open returns with `LIMIT 50` and no cursor, while order pages in the same function paginate properly (`web/src/server/admin-order-discovery.ts`). Measured: with 55 seeded open returns, the view returned 50. An operator cannot reach the remaining actionable returns at all. Smallest remediation: keyset pagination on the same ordering the query already uses (`refund_failed` first, then `created_at`, `id`). Blocks general release for any store whose open returns can exceed 50.

**FF-04, P1, correctness, PR #20.** `product.reorderMedia` verifies that the submitted media set matches the attached set, then rewrites positions. It never compares the current order with the order the editor loaded, despite an error message claiming it does. Measured: two competing reorders of the same product both returned success, and the second order silently became the stored order. The first editor is never told. Smallest remediation: carry the loaded position signature or a product media revision in the payload and reject on mismatch, reusing the existing conflict response shape.

**FF-07, P1, correctness, PRs #31 and #32.** Blog and Page saves carry no expected `updated_at` or revision. The save payload built in `web/src/lib/blog-save.ts` contains content fields only, and the `post.save` and `page.save` actions update unconditionally. Two staff editing the same post overwrite each other with last-writer-wins and no warning at save time. Draft recovery detects staleness only when a device draft exists at load. Smallest remediation: send the loaded `updated_at` with the save and reject on mismatch with the existing conflict pattern from Phase 4A.

**FF-08, P1, transactional integrity, PRs #22 and #23, extends issue #43.** Inventory adjustment commits stock, ledger, and operation receipt in one `db.batch` (`adjustStockIdempotent` in `web/src/server/inventory.ts`), which is correct. The caller then writes the audit row afterwards (`stock.adjust` in `web/src/server/admin-actions.ts`). If the audit write fails, the merchant sees an error for a change that already committed. On replay of the same operation ID, the audit write runs again, so repeated replays accumulate duplicate audit rows for one adjustment. Smallest remediation: include the audit insert in the same batch for the idempotent path, keyed so a replay does not duplicate it. The same pattern across other actions is FF-16.

**FF-05, P2, UX correctness, PR #35.** The discounts page clears edit mode unconditionally after submit (`if (editingId) setEditingId('')` runs regardless of the action result in `web/src/routes/admin/discounts.tsx`). A failed update silently drops the merchant out of editing while showing an error. Confirmed by code path; the underlying action correctly rejects failures. Smallest remediation: clear edit mode only on success.

**FF-15, P2, correctness for non-USD stores, PR #17, recorded in issue #43.** The product detail page still hardcodes dollar price labels in three places while PR #44 fixed the same problem on the creation page with the store currency. A store not using USD sees wrong currency labels on its most-used editing screen.

**FF-13, P2, testing, pre-existing.** `tests/catalog-work.test.ts` fails 3 tests when run in isolation, on the integrated candidate and, measured in this audit, on unmodified `main` (`982d12c`) with the identical result. It passes inside the full suite. This is a test-order dependence on `main` itself, not a stack regression, but it means a green full suite is weaker evidence than it appears and a red isolated run is not automatically a regression. It needs its own investigation before anyone relies on either signal.

**FF-14, P3, integration, PR #21 with PR #44.** The merged products page loses the CSV paste import form that PR #44 retained, because PR #21 replaced it with the dedicated import page and the merge took that side. The final state matches PR #21's stated intent. It is recorded so the removal is a decision, not an accident discovered after launch.

## E. Suspected defects requiring reproduction

**FF-06, draft recovery race, PR #33, confidence highly likely, not proven.** In `web/src/lib/use-draft-recovery.ts`, one effect reads the stored draft asynchronously. A second effect removes the stored draft whenever the current fields equal the loaded server fields, which is true on first render. If the removal lands after the read returns an offer, the stored draft is deleted underneath the recovery prompt; if it lands before, the merchant may never be offered real work. The code pattern is present exactly as the brief suspected. Proving the actual IndexedDB ordering needs a real browser test, and browser tooling is unsupported in this host (the computer-use tool returned an unsupported-call error during this audit). Every IndexedDB timing claim is therefore **not verified**, and the memory-store tests in `tests/draft-recovery-12.test.ts` are not evidence about real IndexedDB.

**FF-09, global search customer query cost, PR #40, confidence plausible at scale.** `EXPLAIN QUERY PLAN` on the test fixture for the customer email query shows a UNION merge over `orders` and `user`, a scan of the merged subquery, and temporary B-trees for ordering, despite `LIMIT 5`. Plan shape is measured; rows read at 100,000 orders is **unmeasured**, because no 100k order fixture was built in this audit. The fix, if measurement justifies it, is two bounded indexed prefix lookups merged in code, not a new search service.

**FF-10, packing slip print isolation, PR #25, not verified.** The packing slip button calls `window.print()` (`web/src/routes/admin/orders/$id.tsx`, line 755 on the stack). No print-only isolation was confirmed or refuted in a real print preview, because the browser is unavailable. Source inspection does not settle what the printed page contains.

**FF-12, product editor navigation, PR #17, confidence likely.** The product editor warns on `beforeunload` only. No router blocker was found. Internal TanStack navigation and record switching while dirty are therefore unprotected as far as code shows; the dirty-state island and the Phase 12 draft recovery do not cover products. Browser confirmation is outstanding.

**FF-20, price edits against prepared checkout state, PR #19, not re-verified.** The Phase 4C contract (checkout validates authoritative D1 prices; a changed price on an existing quote requires shopper re-confirmation) was tested when built and those tests pass on the candidate. This audit did not re-run a prepared-quote or existing-Stripe-session scenario end to end. Treat as implemented, incompletely verified.

**Shipping sample quote permission, PR #36, code-confirmed, impact low.** `previewQuoteFn` in `web/src/routes/admin/shipping.tsx` runs under staff authentication with no resource permission check. Any signed-in staff role that can reach the function can price a hypothetical shipment. No customer or payment data is exposed. Grouped with remediation R6 as FF-11, P2.

## F. Previously raised findings: disposition

- Cross-PR `window.confirm` regression (brief Section 2): **confirmed and still open** as FF-01, reproduced on the integrated candidate.
- PR #44 creation remediations (Section 3): fractional-cent parsing, currency labels, atomic creation audit, uncertain-response handling, role-gated entry, SEO preview, inline form removal, list context, option-loss confirmation, SKU error placement, and database-level creation tests are **implemented and verified**; PR #44's suites (21 tests) and the focused cluster pass on the candidate. The one regression is the confirmation mechanism itself (FF-01). Persistent option groups are **a product decision** (FF-17, DECISIONS.md entry "2026-10-26: persistent product options (pending)"), not a defect.
- Product save atomicity and publication fanout (Section 4): revision conflict tests pass on the candidate; post-write audit placement is FF-16. Price contract re-verification is outstanding (FF-20). SPA navigation is FF-12.
- Media reorder race (Section 5): **confirmed** as FF-04 with a server-level reproduction. CSV behavior suites (`products-csv`, `products-import-5b`) pass on the candidate; BOM and multiline handling were not separately re-exercised beyond those suites.
- Inventory idempotency matrix (Section 6): the stock, ledger, and receipt batch is **correct as designed** and its suites pass. The audit-after-batch suspicion is **confirmed** as FF-08.
- Returns ceiling (Section 7): **confirmed** as FF-03, measured at 55 seeded returns returning 50. Packing slip printing is **not verified** (FF-10). Shipment idempotency and refund state suites (`order-shipping-8b`, `order-workspace-8a`) pass on the candidate; no new Stripe behavior was exercised beyond mocks.
- Guest identity separation (Section 8): **verified**; lookup, workspace, and guest suites pass, and every guest query requires a null `user_id`, so email equality cannot reach account orders. Erasure completeness and approval are **confirmed open** as FF-02.
- Draft recovery race (Section 9): **not verified** against real IndexedDB (FF-06). Editorial concurrency is **confirmed open** as FF-07.
- Discount edit clearing (Section 10): **confirmed** as FF-05. Collections picker and shipping parity suites pass; the shipping sample quote permission gap is FF-11.
- Settings, dashboard, reports (Section 11): checklist, dashboard, and reconciliation suites pass on the candidate, including refund attribution by refund date and currency separation. Timezone is **a product decision** (FF-18). Refund-only and negative-period behavior is covered by the dashboard query's currency union logic and was not separately seeded in this audit.
- Global search (Section 12): stale-response sequencing, permission gating, and short-query behavior are covered by `tests/global-search-18.test.ts` on the candidate. Query plan concern is FF-09. Focus management, Escape from any control, and touch are **not verified** without a browser. The missing mobile trigger is **confirmed** and tracked in issue #41 (FF-19, P2).
- Audit atomicity across actions (Section 13, issue #43): **confirmed open** as FF-16 with the per-action posture summarized in Section G. Issue #43 remains the tracking issue; this report prioritizes within it.
- Issue #41 items: dead `adminOrders` code (still present, still test-pinned, P3), mobile global search trigger (FF-19), store timezone (FF-18), shopper account deletion dialog (outside admin scope, unchanged). The media and collections feedback item from issue #41 was fixed inside PR #42 itself.

## G. Security, privacy and transactional integrity

Guest erasure field inventory (measured against the schema and `web/src/server/guest-data.ts`):

| Store                                               | Contains guest personal data                                                | Erasure today                       | Retention basis in the contract                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `orders` email, shipping name, shipping address, IP | Yes                                                                         | Cleared and email replaced          | Financial facts (totals, tax, currency) retained                        |
| `order_items`                                       | Product facts, no contact data                                              | Untouched                           | Financial record                                                        |
| `returns` rows                                      | Reason and status, no email                                                 | Untouched                           | Fulfillment and refund record                                           |
| `refunds` rows                                      | Amounts and Stripe references                                               | Untouched                           | Financial and reconciliation record                                     |
| `outbox` payload JSON                               | Yes, email at minimum for shipment and account messages                     | **Not touched (measured)**          | Operational delivery record; contract is silent, which is part of FF-02 |
| `audit_log` details                                 | Erasure entry stores the replacement address, not the original (per PR #30) | Acceptable as designed              | Accountability without re-storing the address                           |
| Checkout and reservation records                    | Email and address at checkout time                                          | Not inventoried by the erasure code | Must be inventoried before erasure ships                                |
| Stripe and email providers                          | Yes, outside D1                                                             | Untouched                           | Independent retention; must be disclosed, not promised away             |
| Exports already downloaded                          | Yes                                                                         | Cannot be recalled                  | Must be disclosed in the erasure confirmation text                      |

Identity separation itself verified clean: account history follows `user_id`, guest history requires a null `user_id` and a normalized email match (trim and case-fold only), and the candidate suites prove a shared email never merges the two.

Action and audit matrix (summary of the full inventory behind issue #43): `product.create` writes its audit row inside the creation batch and is the model. The idempotent `stock.adjust` path batches stock, ledger, and receipt, then audits after (FF-08). Roughly 30 other actions in `runAdminAction` (discount, collection, shipping, order, return, media, variant, settings, page, and post families) audit after their writes commit. The failure shape is uniform: an audit failure reports an error after a committed change. Retry safety varies per action: operation-ID and outbox-key protected actions (inventory, shipment email via `shipment-<orderId>`) cannot duplicate their business effect on retry, while plain create actions can duplicate records on a blind retry after an ambiguous failure. No authorization or IDOR defect was found in the new code: role gating reuses the existing permission atoms, guest actions map to the existing customer export and delete atoms, order and customer groups in global search are filtered server-side by `roleCan`, and mandatory 2FA and session behavior were not modified anywhere in the stack. The one gap is the shipping sample quote function's missing resource check (FF-11).

## H. Performance and scaling evidence

Measured on the integrated candidate unless stated otherwise:

- Test D1 (disposable fixtures): the returns ceiling (55 in, 50 out, FF-03), the media reorder race, and the erasure residue were each reproduced against real local D1 through the actual server functions, not mocks.
- `EXPLAIN QUERY PLAN` for the global search customer query shows a UNION merge, a scan of the merged result, and temporary B-trees for ordering. Rows read at 100,000 orders: **unmeasured**. No 100k order fixture was built in this audit.
- Product discovery and catalog scale suites that ship with the stack (including the 5,000 product assembly check and the Phase 2 discovery suites) pass inside the full suite on the candidate. Their local rows-read figures remain relative evidence only, as recorded in the PRs.
- Bundle on the candidate, fresh build: client JS 1,288,863 B in 82 chunks; server startup 3,172,269 B in 41 modules. That is roughly 12 KB of client JS above the Phase 19 head, attributable to the merged creation workspace.
- Source-derived (not measured): collection membership reads per collection, dashboard window queries, and contact lookups are each single bounded statements per request by construction.
- Unmeasured production behavior: deployed checkout coexistence (the at-most-10-percent p95 goal) remains **unavailable**. It was not measured, is not implied by any local result, and must stay an explicit pre-deployment gate. `scale-acceptance` in CI runs only on manual dispatch and was skipped throughout; it is not cited as evidence for anything.

## I. Test and acceptance gaps

- Full suite on the integrated candidate: 816 tests, 813 passed, 2 skipped, 1 failed (FF-01). Every pre-existing stack PR was green alone; only the combination fails, and only on the cross-PR invariant.
- Isolated-suite trust defect: FF-13, measured on unmodified `main`.
- Browser verification: **not executed**. Computer-use tooling is unsupported in this host (measured during this audit), and no authenticated local session was driven. The per-workflow manual checklist is: create one-variant and six-variant products; invalid price and duplicate SKU with form retention; denied creation by role; two-editor product conflict; rich description on the storefront; media reorder competition in two sessions; CSV malformed and duplicate rows; stock adjustment with a dropped response and retry; bulk fulfillment partial failure; order search, shipment, and packing slip print preview; refund state transitions; guest versus account lookup; blog draft recovery after a real reload (this also settles FF-06); collection selection past 200 products; discount edit failure keeping edit mode (FF-05); shipping preview and last-rate deletion; checklist state changes; global search by keyboard, mouse, and touch including the mobile trigger question; owner, manager, support, and warehouse role boundaries; 320px layout; keyboard-only dialog traversal.
- Guest erasure was exercised only on disposable seeded data to measure FF-02, never as production acceptance.
- Migrations: `check:migrations` passes on the candidate. The stack's migration sequence beyond `main` is 0019 (Phase 2B, already merged), 0020 (Phase 4A touch triggers), 0021 (Phase 4B `description_html`), and 0022 (Phase 6A `stock_operations`). No migration was applied anywhere except disposable local D1.

## J. Proposed final remediation program

Surgical PRs, grouped by ownership and transaction boundary. None is implemented by this report.

**R1. Integration confirmation fix (FF-01, FF-14).** Replace `window.confirm` in the product creation page with the shared `ConfirmDialog`, preserving the pending option-change behavior. Owner confirms in the same PR that the merged products page keeps the dedicated CSV import page and drops the paste form. Files: `web/src/routes/admin/products/new.tsx`, `web/src/routes/admin/products/index.tsx`. No schema change. Acceptance: candidate rebuild with PR #42 merged passes `tests/audit-19.test.ts` and the full suite.

**R2. Withhold guest erasure (FF-02).** Remove or owner-gate the `guest.erase` action and its UI entry while keeping lookup, workspace, and export shippable. In the same PR, correct the erasure copy so nothing claims irreversibility the digest does not provide. Files: `web/src/server/guest-data.ts`, `web/src/server/admin-actions.ts`, `web/src/routes/admin/customers.tsx`, `docs/admin-customers/README.md`. No schema change. Acceptance: no reachable erasure path without the Section K decision; export and lookup suites still pass. Completing erasure properly (outbox and checkout-record inventory, non-guessable replacement, exact preview) is a separate later PR that starts only from the owner's contract approval.

**R3. Returns pagination (FF-03).** Add keyset continuation to the returns view on its existing ordering. Files: `web/src/server/admin-order-discovery.ts`, `web/src/lib/order-search.ts`, `web/src/routes/admin/orders/index.tsx`. No schema change. Acceptance: a seeded 55-return fixture pages through all 55 exactly once in both directions.

**R4. Concurrency contracts (FF-04, FF-07).** Media reorder gains an ordering-conflict check using the loaded position signature; blog and page saves gain an expected `updated_at` guard with the Phase 4A conflict pattern. Files: `web/src/server/admin-actions.ts`, `web/src/lib/blog-save.ts`, the media section of `web/src/routes/admin/products/$id.tsx`, blog and pages editors. No schema change. Acceptance: competing reorder and competing save tests each produce one success and one explicit conflict.

**R5. Audit atomicity, prioritized (FF-08, FF-16, issue #43).** Batch the audit insert into the inventory idempotent path first, then the money and stock adjacent actions (order ship, refunds and returns, discounts, shipping rates), leaving cosmetic actions for last. Per action, decide atomicity deliberately rather than mechanically. Files: `web/src/server/admin-actions.ts`, `web/src/server/inventory.ts`. Acceptance: a forced audit failure leaves no committed change for the converted actions, and an inventory replay writes exactly one audit row.

**R6. Merchant-facing correctness batch (FF-05, FF-11, FF-12, FF-15).** Discount edit mode survives a failed update; the shipping sample quote checks the shipping permission server-side; product price labels use the store currency; the product editor blocks internal navigation while dirty or the limitation is explicitly accepted. Acceptance: one failing-then-succeeding test or browser script per item.

**R7. Search follow-ups, only if measurement justifies (FF-09, FF-19).** Replace the UNION customer query with two bounded indexed prefix lookups if a 100k-order fixture shows unacceptable rows read; add the mobile global search trigger. Acceptance: before and after query plans and rows read recorded in the PR.

**R8. Test trust (FF-13).** Investigate the `catalog-work` isolated-run dependence on unmodified `main` and fix the test isolation, so isolated and suite runs agree. Acceptance: the file passes alone and inside the suite, three runs each.

Cross-PR order: R1 before any merging resumes. R2 before the stack is described as shippable. R3, R4, R5 before general release. R6 to R8 by owner acceptance.

## K. Owner decisions required

1. **Persistent product option groups** (FF-17, DECISIONS.md pending entry). Options: ship flat variants as documented (recommended for this release); or fund stored option groups with editor reconstruction and storefront selectors as its own phase. Recommendation: ship flat, keep the documentation honest about what cannot be reconstructed.
2. **Guest erasure contract** (FF-02). Options: withhold erasure and ship the rest (locked default, recommended); approve a retention contract covering outbox, checkout records, and external systems and fund completion of erasure; or gate the entire launch on erasure. Recommendation: withhold, decide the contract deliberately, never under launch pressure.
3. **CSV paste form final state** (FF-14). Confirm the dedicated import page replaces the paste form, as the candidate now behaves.
4. **Store timezone** (FF-18). Options: ship UTC reporting with the on-page disclosure (recommended); or add a store timezone setting as its own change. Recommendation: ship UTC, decide timezone with the settings work, not inside this release.
5. **Checkout price contract** (FF-20). No change is proposed. The owner is asked only to confirm the existing contract (authoritative D1 validation, shopper re-confirmation on a changed quote) remains the launch contract, and to schedule the deferred end-to-end verification.
6. **Merge method for PR #44.** Confirm merge commit, not squash, per the Section B strategy.

## L. Final release checklist

1. R1 merged into PR #44's branch; live CI green; `tests/audit-19.test.ts` passes on a rebuilt candidate.
2. R2 landed or the erasure decision in Section K is recorded as approved with a funded completion plan.
3. PR #44 merges to `main` as a merge commit; full suite and `check:migrations` green on `main`.
4. PRs #17 to #42 merge in numeric order, live CI read after each, with a human watching #21, #29, and #42.
5. R3, R4, and R5 merged, each with live CI green and its acceptance test on `main`.
6. Browser checklist in Section I executed against a local or preview build with disposable data, including print preview and the real IndexedDB recovery test; every item recorded passed or explicitly waived by the owner.
7. Production migration rehearsal on a disposable copy for 0020 to 0022, with a named rollback position per migration (forward-fix only; no down-migration exists).
8. Deployed checkout coexistence measured in an authorized environment, or the owner records acceptance of shipping without it. Never inferred from local results.
9. Rollback readiness: the stack merges as separable PRs, so a bad phase can be reverted per PR; migrations 0020 to 0022 are additive and remain safe under a code revert.
10. Owner signs the verdict upgrade from NO-GO in writing. The agent never merges or deploys.

## M. Final recommendation

1. **Must fix before merge:** FF-01 (R1). Nothing merges while the combined tree fails its own audit invariant.
2. **Must verify before deployment:** the Section I browser checklist including packing slip print isolation (FF-10) and real IndexedDB recovery (FF-06); price-contract verification against prepared checkout state (FF-20); migration rehearsal; deployed checkout coexistence, or an explicit recorded waiver.
3. **Safe to defer with explicit approval:** FF-03, FF-04, FF-07, FF-08 and FF-16 (R3, R4, R5) only if the owner accepts the named risks in writing; FF-05, FF-11, FF-12, FF-15 (R6); FF-09 and FF-19 (R7); FF-13 (R8); FF-14 is closed by the Section K confirmation.
4. **Decisions blocking remediation:** guest erasure (blocks R2's final form, not the stack), persistent option groups (blocks nothing in this release if flat variants ship as documented), merge method for PR #44 (blocks the merge sequence), store timezone (blocks nothing if UTC ships disclosed).
5. **Exact next actions after owner approval:** the agent implements R1 on PR #44's branch and re-reads live CI; the owner merges PR #44; the agent then babysits each subsequent PR in order, rebasing only if a merge demands it and re-reading CI after every step, and stops again before any deployment step. Erasure stays withheld until its own decision lands.

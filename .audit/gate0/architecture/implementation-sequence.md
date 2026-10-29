# Proposed implementation sequence after Gate 0 approval

No feature PR is authorized by this document. Every PR retains server authorization, 2FA, stock/payment invariants and existing publication/recovery. Interaction changes require browser screenshots, keyboard/mobile task completion and relevant resource evidence. Any new schema is named explicitly in that PR.

| PR | Complete merchant outcome | Dependency | Verification boundary |
|---|---|---|---|
| 1 | Navigate Orders on desktop and mobile through the new neutral shell | Approved Gate 0 | Role navigation, focus, deep links, responsive screenshots and no extra loader calls |
| 2 | Find a product by SKU/title and return to the same filtered list | 1 | Indexed exact/prefix SKU and FTS, stable cursor ties, capped projection at 100k |
| 3 | Create a draft product with six variants and media | 2 | Unique SKU, bounded transaction, media rejection, publication capture and retry behavior |
| 4a | Save all product metadata through one reviewed per-record island | 3 | Atomic existing-revision CAS, changed fields, conflict recovery and honest publication status |
| 4b | Write and display a rich product description | 4a | Sanitizer, nullable HTML migration, plain-text fallback, publisher document compatibility and FTS |
| 4c | Edit selected variants as one explicit operation | 4a; price contract approval | Bounded writes, price visibility during checkout, no stock hidden inside content drafts |
| 5a | Correct one SKU safely and see its ledger history | 1 | Deterministic ledger receipt, lost-response replay, guards and audit |
| 5b | Adjust a reviewed selection with item-level outcomes | 5a | Bounded concurrency, mixed failures, retry failed/uncertain items only |
| 6 | Find paid/unfulfilled orders by number/email/status | 1 | Indexed plans, stable ordering and no unrelated returns-list load |
| 7 | Inspect an order, print a packing slip and record shipment | 6 | Existing transition/outbox, clear confirmation, refund/return permission boundaries |
| 8 | Fulfill a reviewed batch and recover partial results | 7 | Stable result IDs, keyed shipment outbox, interrupted responses, no duplicate notifications |
| 9a | Find account and guest purchase records in a labeled contact view | 6; approved identity/privacy contract | No ownership inference from email, search pagination and sensitive fields |
| 9b | Export or erase a selected guest contact scope | 9a | Exact previewed order IDs, owner permission, transactional scrubbing and retention |
| 10a | Write, preview and save an article or legal page | 1, 4a patterns | Shared rich editor, sanitizer/media, status and conflicts |
| 10b | Recover editorial drafts across reload/navigation if evidence justifies it | 10a; separate persistence approval | IndexedDB failure, identity isolation, quota loss, cross-tab revision conflict and export |
| 11a | Select a product beyond the first 200 in a collection | 2 | Indexed picker and collection revision CAS |
| 11b | Edit and pause a discount | 1 | Checkout redemption/idempotency and in-progress checkout semantics |
| 11c | Edit shipping rates with a human-readable country chooser | 1 | Existing quote parity, permission and deletion constraints |
| 11d | Configure store and staff through grouped settings | 1 | Existing schema/permissions, session revocation and advanced safety |
| 12a | See accurate date-scoped Home totals and actionable queues | 6; definitions approved | Timezone, currency/refund semantics and bounded queries |
| 12b | Explore period analytics and export matching figures | 12a | Reconciliation, historical scale, query cost under checkout load |

The sequence has branches. Inventory and Orders do not wait for rich descriptions or editorial drafts. Shell components are created only as a proving workflow uses them. Each migrated workflow removes its obsolete inline forms in the same PR. No generic registry or duplicate editing path is retained solely for compatibility.

Resource comparison applies only to touched resources. Mark a metric not applicable or unavailable rather than claiming a measured zero. Every PR that introduces write fanout records publisher, D1, KV, queue and purge work through completion, not just initial request latency. Checkout under concurrent admin work remains the shared acceptance gate.

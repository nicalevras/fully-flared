# Checkout hardening checkpoint — 2026-10-23

Implementation checkpoint only. Migration 0016 is prepared, not applied. Tests,
typechecks, builds, migration checks, browser journeys and provider calls are
deferred until the requested review pause. This is not production acceptance.

## Approved architecture

Use hosted Stripe Checkout. This explicitly supersedes v1.2's inline Payment
Element requirement. The application owns the address, delivery selection,
discount and review; Stripe owns payment credentials. Preparation creates no
stock reservations or coupon claims. Verified authorization precedes atomic
allocation, capture and sale finalization. No dependency or queue service is added.

## Requirement ledger

| Requirement                               | Implementation                                                                                                                                                                                                                     | Deferred regression                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Bind attempts to their cart               | Cart responses include opaque ID/revision; request validation and both fingerprints include them. Existing-attempt handling verifies the cart capability and revision.                                                             | Identical second purchases, edit/restore, foreign carts, changed revisions and old browser identities.  |
| Preserve completed purchase access        | Ownership-checked paid retries return a signed success URL; absent converted-cart cookies do not require creating a replacement order. A different current cart rejects the old attempt.                                           | Account/guest completion, lost responses, converted and cleared cookies, new cart after payment.        |
| Clear stale reviews, preserve uncertainty | Typed `STALE_ATTEMPT` conflicts reset browser intent/review and explicitly refresh the cart. Network errors preserve the intent. Confirmation checks cart ownership again.                                                         | Stale confirmation, cross-tab changes, uncertain response and manual retry.                             |
| Finish pre-finalization full refunds      | A guarded compensation transaction checks verified capture, successful refund totals and absence of committed reservations; it cancels unfulfilled fulfillment, finalizes the attempt, and releases remaining stock/coupon claims. | Refund/finalization races, replay, reversal, dispute preservation, no duplicate refund or paid receipt. |
| Cancel according to provider status       | Persist cancellation intent before expiring an open Session or directly canceling a `requires_capture` PaymentIntent. Unresolved outcomes remain due for recovery.                                                                 | Session expiration races, cancellation timeout, capture winning, requires-action/processing states.     |
| Independent financial families            | Seven task names use the existing maintenance table and JOBS queue. Legacy staged financial runs dispatch those same families idempotently.                                                                                        | One unavailable or failing family must not starve capture, refunds, webhooks or email.                  |
| Bounded provider maintenance              | Shared 30-second delivery deadline; individual calls at most 10 seconds; no new call below 5 seconds remaining. Existing transport deadlines include nested SDK calls/retries.                                                     | Slow calls, deadline exhaustion, claim loss and transport uncertainty.                                  |
| Resumable historical reconciliation       | Successful records advance durable cursors with the current maintenance claim. Delivery deadlines can stop a page midway.                                                                                                          | Partial pages, lease replacement, provider outages and coverage completion.                             |
| Preserve rejected cache purges            | Check returned `success`, log safe error codes, retain invalidations on failure, and delete only the exact selected delivered-reference records.                                                                                   | Resolved-false, thrown failures and a newer publication arriving during purge.                          |
| Recover incomplete public writes          | Destination records precede public puts; originals register before storage writes; upload readiness and publication claims prevent premature attachment.                                                                           | Public put succeeds then D1 fails, original/variant failure, late completion and deletion races.        |
| Delete all known destinations             | Pending and ready publication destinations participate in deletion/purge; tombstones survive parent removal. Failed cleanup retains the deletion-pending media record.                                                             | Partial deletion, purge failure, historical base URL and manual retry.                                  |
| Publish existing media explicitly         | Admin Media has a permission-checked, confirmed operator action. Existing maintenance runs process one original or actual ready variant per delivery with a keyset cursor and fixed coverage cutoff.                               | Restart, failed object, changed/deleted media, multiple destinations and permission denial.             |

## Migration 0016

`0016_checkout_and_media_recovery.sql` adds original readiness/upload claims and
`media_publications`, with destination uniqueness, immutable identity, guarded
readiness, deletion protection and retained deletion tombstones. Existing originals
default to ready; known existing public URLs seed destination records. Upload-claim
updates do not dirty the catalog. No table is reconstructed, no inventory changes,
and no historical financial accounting is recalculated.

Metadata was generated in isolation with installed Drizzle Kit. The first attempt
failed because its Windows absolute output path was prefixed with the working
directory. Generation succeeded using a relative path to the same isolated folder.
Only the new migration/snapshot and journal update were copied back. Custom SQL
adds the reviewed guards and known-destination registration. Automated drift and
SQL execution checks have not run.

Before applying locally, stop only verified workspace services and children, copy
all Wrangler persistence including WAL/SHM files, compare source/copy SHA-256
hashes, and record the paths. Apply only after that checkpoint's approval. Keep one
runtime per persistence directory. No migration or service restart ran here.

## Operating recovery

Financial families are reservation expiry, order expiry, webhook recovery,
checkout preparation, authorization recovery, outbox recovery and refund recovery.
They keep independent due times and claims. Admission refusal defers the affected
family; errors retain durable work. Existing 15-minute wake-ups, hourly privacy
cleanup, daily maintenance and the six-hour dead-webhook retry policy remain.

Historical reconciliation uses a fixed coverage cutoff and records progress after
successfully checked records. A stale claim cannot advance its cursor. Provider
errors do not become proof that an object is missing. Existing backlog/coverage
logs and authorization overdue/escalation alerts remain the operational evidence.

Configure public storage, delivery base URL and purge credentials before using
**Admin → Media → Publish existing media**. The action is explicit and can resume
an unfinished run. Setting the base URL alone never starts a bucket migration.
Only recorded originals and ready variants are copied, one object per delivery;
deletion-pending images are skipped. A failed object retains its cursor position.
Changed ready URLs use existing catalog work capture and publication.

Incomplete original uploads are visible in admin for removal/re-upload. Incomplete
variant/publication records retain their identity for retry/deletion. Deletion
removes local objects, all recorded public objects and cached URLs before removing
the parent record. A changed base URL does not erase old destinations. Keep the
same PUBLIC_MEDIA bucket binding until an explicitly planned bucket migration.

D1 and R2 are not one transaction. Claims and readiness prevent an unfinished
publication being advertised, while retained destination records/tombstones make
its cleanup recoverable. Historical orphan objects created before tracking was
introduced are not proven absent and are not silently scanned or deleted.

## Next checkpoint: verification, not performed here

Add focused behavioral regressions for the ledger above, then run relevant tests,
web typecheck/build, migration drift and fresh/populated 0016 migration checks.
Review existing typed checkout/cart fixtures for the new required cart binding.
Use disposable state and stubbed providers. Back up persistence before any local
migration. Run the ordinary suite and isolated 100k gate only at their separately
agreed acceptance checkpoint. Real Stripe behavior, deployed cache propagation,
capacity, billing and production soak remain external gates.

Before migration, undo uses this round's working-tree before-images, not HEAD.
After application, schema reversal needs a new forward migration. No blanket reset
or historical migration edit is part of recovery.

## Documentation basis

Context7 was queried against Stripe Node 23.0.0 and Cloudflare documentation;
installed API types remain the compatibility reference. No dependency changed.

- [Stripe Node request timeouts and retries](https://github.com/stripe/stripe-node/tree/v23.0.0#configuring-timeout)
- [Checkout PaymentIntent cancellation restrictions](https://docs.stripe.com/api/payment_intents/cancel)
- [D1 transactional batches](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Workers cache purge acceptance results](https://developers.cloudflare.com/workers/cache/purge/)
- [R2 deletion and CDN cache consistency](https://developers.cloudflare.com/r2/reference/consistency/)

## Source backup

`C:\Users\nicka\store-remediation-backups\20261023T041501Z\checkout-hardening\`

370 source files were copied and verified byte-for-byte using SHA-256 before any
source edit. `SHA256.json`, `HEAD.txt`, `STATUS.txt`, `staged.patch` and
`unstaged.patch` preserve the implementation baseline. `NEW-FILES.txt` records
files introduced in this checkpoint. Secrets and Wrangler state were not read or
copied because this checkpoint does not apply a migration or operate services.

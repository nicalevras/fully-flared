# Local production-hardening checkpoint

This ledger records the hardening of `v3` (`891e359`). Implementation and local
verification are distinct from deployment acceptance. No deployment, remote
migration, real provider request, commit or push is authorized by this checkpoint.

## Verified checkpoint and migrations

Evidence and before-images:
`C:\Users\nicka\store-remediation-backups\20261023T131818Z\production-hardening\`.
All 378 source before-images and 132 Wrangler persistence files matched their
source SHA-256 hashes. Workspace Vite and its runtime child were stopped before
copying persistence. Present SQLite sidecars were included.

Fresh and populated disposable migrations completed successfully. Local `0016`
and `0017` subsequently applied successfully. Financial/media row counts were
preserved; foreign-key violations and inventory-ledger discrepancies were zero;
SQLite integrity returned `ok`, and FTS remained queryable. The populated and
fresh schemas are equivalent; two old catalog definitions differ only in quoting
and formatting. The prior historical migration alteration remains historical,
not newly proven by this comparison.

`0017` was reviewed before application. Query plans on 1,000-row table fixtures
used three of the original six proposed indexes. Unused outbox-retry,
refund-retry and pending-webhook indexes were removed from SQL/schema/metadata
before application. The retained indexes cover stale outbox claims and refund
age/attempt selection. Refund fixture reads decreased from 348 to 171 and from
1,169 to 280. These measurements are local fixture evidence, not universal query
or billing guarantees. Existing indexes cover the other examined selections.

## Requirement ledger

| Requirement | Implementation and local evidence | Remaining evidence |
| --- | --- | --- |
| Clean CI environment | Fresh root/web installs and generated declarations without local secrets; lint, formatting and production build passed | Recheck gates affected by final repairs |
| Queue isolation | Task-aware maintenance dispatcher; generic maintenance enqueue refused; configured queue-role map validated; misplaced consumer messages forwarded before ack | Focused queue tests pass; external delivery remains at least once |
| Conditional watchdog | Shared eligibility, fixed cutoff, independent dispatch, live-claim/backoff preservation, deterministic alert IDs | Idle, independent failure and legacy compatibility regressions pass |
| Recovery progress | Reservation/order mutation counts; webhook/preparation/authorization/refund postconditions; conservative delay for unchanged due work | No new orchestration service or scheduler |
| Notification recovery | Finite 25-row pages; cursor advances after accepted enqueue; immediate committed mail still goes to notifications | Pagination/failure recovery regressions pass; external delivery can redeliver |
| Authorization-first stock | No allocation at preparation; guarded stock/coupon allocation after authorization; exact-amount capture and durable uncertainty | Stubbed last-unit, uncertainty, free-order and compensation regressions pass; real Stripe pending |
| Legacy refund compensation | Fully refunded unfulfilled legacy purchases use a guarded compensation transition; no second refund or receipt | Failed ordinary regression corrected and focused follow-up passed |
| Boundary validation | Validate settings values before currency-lock conflicts; unexpected errors retain generic responses | Actual HTTP checks pass, including invalid currency 400 and locked currency 409 |
| Media lifecycle | Claim-losing responsive uploads reach deletion cleanup; immutable variant keys and retained records remain | Actual HTTP upload/permission checks pass; remote public delivery pending |
| Catalog maintenance | Idle GC/replica work receives budget before publication bookkeeping; pending publication remains higher priority | Focused budget/liveness checks in progress |
| Public/private delivery | Existing published readers, pinned fallback, semantic keys, CSRF and private response rules retained | Local HTTP/browser checks performed; deployed cache propagation pending |
| Security/dependencies | Secret scan: 378 tracked files and 495 build files, including comparison with local secret values; no matches | Dependency advisories classified below; no version upgrades |

## Test budget and failures

The ordinary suite ran once: **532 passed, 31 failed**, plus three suite-collection
errors caused by undeclared root imports of dependencies installed under `web`.
Failures and native exit results remain in the evidence folder. Do not describe
this run as green. Only affected checks and failed cases are rerun.

Corrections include stale checkout/cart/address fixtures, authorization-first
expectations, the renamed Session-duration setting, immutable media keys, opt-in
reminders, explicit historical migration cutoffs and the Workers purge result
contract. Original financial and per-invocation resource assertions remain.
Catalog queue tests model elapsed time between deliveries and explicitly request
daily replica/GC work. The two larger catalog integration cases have an explicit
180-second harness timeout; operation ceilings and convergence assertions are
unchanged. No automatic database transport retry was added.

The required isolated 100k gate remains pending until the focused repairs finish.

## HTTP and browser evidence

HTTP journeys use copied persistence and fixture credentials. The browser-only
copy additionally replaces the provider with an in-memory adapter and a local
payment-completion endpoint. Those fixture changes are outside the repository
and are not release code.

Actual Start HTTP checks passed for authentication/2FA, permissions, validation,
ownership, private headers, protected/atomic deletion, customer exports, media
uploads and structured results. The browser confirmed a $42 reviewed order;
the prepared order was unpaid with zero reservations. Stub authorization/capture
then produced paid/finalized state, one committed reservation, one receipt and a
converted cart. Screenshot and before/after database evidence are saved outside
the repository. This proves local application wiring, not Stripe behavior.

## Security review and release boundaries

The one production-dependency audit reported 12 package findings: 7 high and
5 moderate, with no critical finding. High-severity paths come through unused
shadcn CLI tooling and its registry/glob dependencies, not a traced Worker request
path. The sanitizer has three moderate advisories. The current allowlist excludes
SVG/SMIL, meta tags and executable URL schemes; focused payload tests pass. The
noscript parsing advisory can still change inert-content semantics, so this is
not a claim of a vulnerability-free dependency tree. Review a narrow sanitizer
security update separately; no dependency versions changed here.

Before launch, separately authorize real Stripe test-account validation,
subscription/account checks, deployed cache/media propagation, sustainable load,
reconciliation soak and a preview D1 Time Travel recovery rehearsal. Install fresh
production secrets rather than reusing credentials shared in conversation.

## Documentation basis

Context7 supplied the current [Queues message/ack contract](https://developers.cloudflare.com/queues/configuration/javascript-apis/),
[D1 index review guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/)
and [local migration persistence options](https://developers.cloudflare.com/workers/wrangler/commands/d1).
Installed types/source determine version-specific behavior; no dependency upgrade
or compatibility-date change was made.

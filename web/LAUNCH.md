# Launch the store

Deploy one store to your own Cloudflare account. Local verification does not
prove a deployment is ready. No remote operation in this runbook has been run
as part of the local remediation.

## Reader publication transition

The coherent-reader format uses content-addressed page keys (without a build
generation in the key), immutable editorial/collection documents with small
pointers, and published collection/journal indexes. After upgrading, rebuild
derived catalog data through the catalog publisher before accepting public
traffic. Do not erase financial data or substitute live product queries for a
missing published document. Ordinary KV loss uses committed-artifact repair,
not a source rebuild.

Local migrations through `0012_catalog_reclamation.sql` were applied on
2026-10-22. Migration 0011 adds reader ordering indexes; 0012 adds catalog GC
state, artifact retirement tracking, root-change guards and retention indexes.
It performs no table reconstruction or financial backfill. Remote migrations
have not been applied.
Healthy public HTML must render without D1, including nested layout/SEO reads;
availability, search, redirects for unknown slugs and private functions are
separate database paths. Local HTTP evidence is recorded in REMEDIATION.

## Configure the deployment

Use Node 24 and the committed lockfiles. Replace installer placeholders in
`wrangler.jsonc`: public `BETTER_AUTH_URL`, KV namespace ID and numeric
rate-limit namespace IDs. Deployment to workers.dev is supported without a
custom domain or route. Caching stays enabled and becomes effective when you
add a supported custom domain or route; missing one is a non-blocking note.
Named environments have their own D1, R2, KV, queues and rate-limit bindings.
Keep development origins out of deployment configuration.
Set a valid, nonempty `OWNER_EMAIL` for the deployment's owner account. The validator
rejects malformed email, an empty value and the `REPLACE_WITH_STORE_URL` auth URL placeholder;
generic repository builds remain usable before these values are configured.

Provision `store-jobs` (financial work), `store-notifications` and
`store-catalog`, the shared dead-letter queue `store-jobs-dlq`, and the
matching `-preview` queues before deploying. The catalog consumer must have `max_concurrency: 1`. Configure Cloudflare Email
Service with a verified sender domain and the `EMAIL` binding. Check the sending
quota before launch and request an increase if expected email volume exceeds it.
D1/R2/DO provisioning follows the installed Wrangler configuration.

Configure the auth, Stripe and optional Turnstile secrets using Wrangler's secret
prompt or a secret manager. Never place secret values in command history.
Configure the matching Turnstile site key in the admin when enabling it.

`npm run deploy` runs configuration validation before building/deploying. A
plain repository build works with installer placeholders. Direct Wrangler
commands bypass the npm predeploy check: run the validator explicitly first.
For a named environment, run `node scripts/validate-deploy.mjs preview`.
The validator reads this repository's JSON/JSONC directly using the installed
JSON5 parser. Selected-environment vars, KV/rate-limit bindings and queues do
not inherit root values. It does not import Wrangler's unstable configuration
API or replace Wrangler CLI schema validation.

On a first install, deploy/provision, apply remote migrations, and verify the
schema before enabling traffic. The migration chain is a squashed baseline
(0000_initial.sql plus forward repairs): before applying it to any existing
database, confirm that database was never deployed from the pre-squash
0000-0029 chain - the baseline must not be applied over it. On upgrades, back up and rehearse the forward
chain before applying it and deploying dependent code. Never rewrite an applied
migration or run generated parent-table reconstruction SQL.

## Register the Stripe endpoint

Use `https://STORE_HOST/api/webhooks/stripe` with API version
`2026-09-30.endive`, matching stripe-node 23.0.0. Subscribe to this complete list:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `payment_intent.payment_failed`
- `payment_intent.amount_capturable_updated`
- `payment_intent.succeeded`
- `payment_intent.canceled`
- `refund.updated`
- `refund.failed`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.closed`

`src/server/stripe-events.ts` is the required event manifest. Tests compare it
with handled payload validators. Build local Stripe CLI forwarding arguments
from that manifest instead of maintaining a second event list:

```sh
node scripts/stripe-listen.mjs --print
```

Remove `--print` only when authorized to connect Stripe CLI. Local signature tests
verify every manifest event and duplicate delivery without contacting Stripe.
Export the actual
endpoint object from Stripe and run:

```sh
node scripts/check-stripe-subscriptions.mjs ENDPOINT_JSON
```

Replace `ENDPOINT_JSON` with that export. Confirm its URL, account, mode, enabled
status and subscriptions against the deployment. A local fixture cannot verify
remote subscriptions. Test pending/failed refunds, successful charges and
duplicate deliveries before accepting payments.

## Bootstrap and configure the owner

For local development, run `npm run bootstrap:owner`. For an authorized remote
bootstrap, explicitly select remote storage and `WRANGLER_ENV=production` (or a
named environment) before running the script against its configured HTTPS origin.
A local Tunnel requires explicit `WRANGLER_REMOTE=0`.

Enter the email and hidden password when prompted, or supply them through a
secret manager as process environment variables. The password is consumed by
the script, never stored as a Worker variable. The script creates an account
through Better Auth, verifies/promotes that exact new account through the
selected D1 target, and checks the affected row. Existing accounts must sign in
as an owner/admin; an existing customer is never silently promoted. Failure
exits nonzero. Public sign-up always creates an unverified customer.

Enable 2FA before using the admin. Configure store identity, canonical origin,
currency, verified sender, operational alert recipient, shipping zones and rates.
Better Auth's admin-plugin HTTP routes return 404; use the store's admin actions
for role changes and account management. Internal plugin calls remain behind
the store's staff/2FA and permission checks. The customer directory requires
`user.list`; uploads require `media.upload` (owner, legacy admin or manager).

Owner/admin accounts cannot delete themselves. Another owner must first demote
the account before administrative deletion. Migration 0019 also prevents deleting,
demoting or banning the last unbanned owner/admin, including concurrent requests.
If no owner exists, recover with the explicit bootstrap procedure above; changing
`OWNER_EMAIL` alone does not restore or promote an account.

Migration 0022 also rejects direct deletion of any owner/legacy admin until
demoted. Self-service and administrative deletion use the same guarded D1
transaction: eligibility, anonymization, nullable account links and identity
removal either commit together or roll back. Financial returns and published
posts remain, detached from the deleted account. Better Auth still verifies
self-service authentication/freshness and clears its cookies; administrative
deletion uses the atomic store helper instead of the plugin's separate writes.

Empty alert recipient falls back to verified owners. Physical products require
an address and an explicit eligible rate; free shipping uses a configured $0
rate. Set variant weights and backorder flags where intended. Configure Stripe
Tax registrations and product tax codes before enabling and confirming tax setup.
Missing required configuration blocks payment. Replace demo products/content
before launch. Seed stock is not real inventory.

Currency cannot change while a checkout is pending and locks permanently after
the first completed order. Checkout sends the persisted order currency to
Stripe. Percentage coupons accept 0–100 and apply only to the merchandise
subtotal. Customer limits use each coupon's `usage_per_customer` value. New
attempts claim no stock/coupon capacity before authorization. The app freezes
shipping and a Session-backed total for explicit review. After confirmed card
authorization, D1 claims capacity before capture. Provider uncertainty preserves
allocated stock. Superseded attempts are fenced and expired/canceled or refunded
as appropriate; changing details cannot authorize a second fulfillment.

Free orders still require a valid Stripe Checkout Session, destination and rate.
A completed `no_payment_required` session with a validated zero total needs no
PaymentIntent. It commits inventory and creates a receipt once. Free-order
returns approve without a monetary refund; restocking still requires stock
permission. For expired checkouts, late payments recover both stock and coupon
capacity or receive a durable refund operation. An unrecoverable free order
cancels and notifies the shopper without calling Stripe refunds.

A canceled checkout paid after the store changes currency is also unfulfillable.
The store creates a durable refund operation against the original PaymentIntent
and currency, without committing stock, issuing a receipt or locking the new
store currency. A zero-total session instead cancels/notifies without a refund.
Pending, failed or uncertain refunds remain visible for operational recovery;
check the existing operation before attempting a manual refund.

Dashboard/report totals show each order currency separately. Product and customer
exports now include `currency` and group their monetary totals by it. Consumers
must use currency as part of their grouping key; no exchange-rate conversion or
historical accounting rewrite is performed.

A return with an active or successful refund cannot be rejected or approved
without that refund. Pending/failed settlement stays visible for recovery;
successful settlement updates the return once. Migration 0020 adds these guards
without changing existing coupon accounting or rebuilding tables.

## Verify locally

From the repository root run `npm test` and `npm run lint`. From `web` run:

```sh
npm run cf-typegen
npm run check
npm run check:migrations
node scripts/verify-tracer.mjs
node scripts/verify-http.mjs
node scripts/reconcile.mjs
node scripts/load-test.mjs
```

Start the local dev server before HTTP/load checks. Record failures and flakes;
an isolated rerun does not make a failed full run green. See `REMEDIATION.md` for
local evidence.

## Verify deployment before release

The preview CI job regenerates types and builds with `CLOUDFLARE_ENV=preview`
before invoking Wrangler. This prevents a production-configured build artifact
from being reused for a preview deployment. Rehearse artifact generation locally
without deploying (PowerShell):

```powershell
$env:CLOUDFLARE_ENV = 'preview'
try { npm run build } finally { Remove-Item Env:CLOUDFLARE_ENV }
```

Inspect `dist/server/wrangler.json` for preview resource names. Run the ordinary
`npm run build` again before starting the normal local production preview.
Neither build command deploys. Recovery is D1 Time Travel; there is no
scheduled backup to verify. See "Backups and recovery" in the root README.

- Verify real Stripe test-mode charge/refund lifecycles, actual endpoint
  subscriptions, signed webhook forwarding, and shipping/tax totals.
- When a custom domain/route is configured, verify Cache API hits and cookie,
  authorization, private-route and server-function exclusions. Keep supported-host
  cache acceptance pending until then; this does not block workers.dev deployment.
- Send an authorized receipt to a controlled inbox and verify sender delivery
  and quota. Notification insertion is once-only; ambiguous transport may resend.
- Exercise staff password/2FA, owner bootstrap, exact development Tunnel origins,
  cross-origin WebSocket rejection, media failure and reconnection.
- Meet deployed performance targets and complete the reconciliation soak. Local
  invariant runs do not count as deployed CLEAN days.
- Rehearse a D1 Time Travel restore on the preview database, verify FTS
  and inventory afterwards, and confirm the restore can be undone with the
  pre-restore bookmark.

Production charges, remote subscriptions, supported-host cache hits, deployed
performance and soak acceptance remain pending remote authorization.

## Architecture completion checkpoint

Use `ARCHITECTURE-COMPLETION.md` for current requirements and unresolved gates.
Round 1 migration 0009 was applied to the local dev database after explicit
approval on 2026-10-21. Complete stopped-state backup hashes, migration output
and post-migration integrity checks are recorded in REMEDIATION. Remote
application remains separately authorized work; local success establishes no
deployed verification.

After authorized application, inspect unresolved checkout intents before retrying
provider creation. `creation_stopped_at` means creation POSTs are prohibited;
retrieve known sessions or use the bounded provider metadata reconciliation scan.
Do not clear it to force a replacement checkout. Expired holds can release stock
while provider reconciliation remains outstanding; a later payment still follows
fulfillment-or-refund policy. Real provider verification remains pending.

## Reclamation acceptance

The existing catalog queue runs one bounded cleanup unit after publication work.
Cron still enqueues wake-ups; it never performs catalog publication or GC itself.
Inspect `catalog_gc_state` for phase, cursor, epoch and next run, and
`catalog_artifacts` for deletion-pending, retry time and generic failure state.
A missing/invalid referenced directory stops marking before any sweep. Restore
its committed mirror through the existing repair path before retrying cleanup.
A live or paused nonterminal build defers cleanup. Investigate abandoned build
checkpoints instead of deleting their artifacts manually.

Local evidence covers failed KV deletion/retry, publication racing deletion,
shared roots, populated upgrades, retention and the actual queue budget. Full
ordinary/100k acceptance remains deferred at the user's request. Real-provider
behavior, cache propagation, sustainable throughput and the production soak
remain separate release gates. Do not infer production readiness from this
focused checkpoint. Roll back applied schema changes with a new forward migration
(0013 or later), never by editing 0012.

## Authorization-first acceptance (pending)

The 0013 authorized checkout, 0014 event-driven operations and 0015 public media
delivery migrations are prepared only. No remote or local migration application
is part of this implementation checkpoint. Preserve secrets/media and compare
complete Wrangler-state hashes before local application in verification.

Release requires exact equality between app review, Session and authorized
amount/currency, including tax and shipping. Test destinations, address changes,
discounts and trusted tax-exemption configurations. No browser field grants an
exemption. Retired open Sessions must expire; requires_capture authorizations
can be canceled directly; uncertain captures require retrieval/compensation.
No unresolved capture allocation may be released on a timer.

Recovery target: event-driven immediate processing, a warning after five minutes
of unresolved authorization, and escalation at the 15-minute safety tick. These
are alert targets, not evidence of achieved latency or forced terminal outcomes.
Inspect maintenance_progress/maintenance_backlog and oldest unfinished coverage.
Abandoned reminders default off; enable only with consent/suppression policy.

Optional public media requires a dedicated PUBLIC_MEDIA bucket/custom domain,
validated media_public_base_url setting and zone-scoped purge credentials. The
local MEDIA binding and /media route remain the default. No bucket/domain/token
was provisioned here. Verify every actual variant deletion and purge remotely
before claiming CDN removal.

Local application update: the user subsequently authorized0013–0015. All applied
locally with a stopped-state hash-verified backup; integrity checks passed.
See REMEDIATION.md for evidence. Remote migration and full lifecycle acceptance
remain pending.

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

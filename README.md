# Store

A single-store commerce app built with TanStack Start on Cloudflare Workers.
D1 stores commerce data, KV holds the partitioned catalog read models,
R2 stores media,
and Stripe Checkout collects payments. The realtime Durable Object is
restricted to staff.

## Run locally

Use Node 24 and the committed lockfiles. From the repository root:

```sh
npm ci
cd web
npm ci
npm run setup
npm run dev -- --port 8799
```

Put local secrets in `web/.dev.vars`. Run `npm run bootstrap:owner` from `web`,
then sign in and enable 2FA. Configure a shipping zone and an explicit rate in
Admin before testing physical checkout. Missing Stripe configuration returns
503 without taking an order or clearing the cart.

Use the store admin to manage accounts; the auth plugin's admin HTTP endpoints
are disabled. Owners must be demoted by another owner before deletion, and the
last unbanned owner/admin is protected. Image uploads require owner, legacy admin
or manager permissions. Product CSV imports are limited to 1,000 rows per file.
See the launch guide for bootstrap and recovery.

Localhost works without `DEV_TRUSTED_ORIGINS`. When sharing the dev server
through a Tunnel, copy the commented example from `web/.env.example` into
gitignored `web/.env.local`, uncomment it and set the exact origin (comma-separated for several),
then restart Vite. Wildcards are rejected; do not use an arbitrary request host.

See [web/README.md](web/README.md) for development and verification commands
and [web/LAUNCH.md](web/LAUNCH.md) for release configuration and external
acceptance.

Public pages read published KV documents. If an immutable value is missing or
invalid, the reader uses that exact publication's D1 mirror; it does not expose
unpublished source edits. Availability, search and private actions still use D1.
Catalog changes become public through the bounded catalog queue consumer. Home,
collection discovery and the journal have pagination; navigation and homepage
teasers stay fixed size. See `web/ARCHITECTURE-COMPLETION.md` for current local
evidence and the remaining acceptance gates.

## Backups and recovery

Recovery is D1 Time Travel. There is no automated backup export and no
backup bucket; recovery does not depend on application code.

- Inspect restore points: `npx wrangler d1 time-travel info store-db` (run
  from `web/`). Time Travel commands always act on the remote database;
  there is no `--remote` flag.
- Restore in place: `npx wrangler d1 time-travel restore store-db --bookmark BOOKMARK`.
  Replace `BOOKMARK` with a bookmark from the info command.
  A restore overwrites the database in place at that point in time. It
  cannot create a new database, cannot restore a single table, and only
  works within the same Cloudflare account. Time Travel keeps 30 days of
  history on the Workers Paid plan and 7 days on Free, and is always on.
- A restore can be undone: the restore command returns a bookmark for the
  state just before the restore, so restoring to that bookmark reverses it.

Time Travel is the only supported restore path. There is no supported
import-restore procedure: importing exported rows into a migrated database
fails, because migrations already insert seed rows (such as default
settings) and business triggers and currency locks reject historical rows.

### After a restore

Time Travel restores D1 only. The catalog read models in KV and any cached
HTML are **not** restored, so they can describe products that no longer
match the restored database. Before reopening writes:

1. Clear the catalog KV keys so the next cron pass bootstraps a full
   rebuild from the restored D1 state (D1 is authoritative; the rebuild
   republishes listing pages, the layout model and product documents).
   Use `npx wrangler kv key list --binding CATALOG_KV` from `web/` to see
   the keys, then delete them (`npx wrangler kv key delete --binding
CATALOG_KV KEY` per key, or a bulk delete for the namespace).
2. Let the scheduled maintenance pass (or the next catalog edit) publish
   the rebuilt generation, and confirm storefront pages show restored
   data.
3. Cached anonymous HTML is bounded by its 60-second TTL, so stale pages
   age out on their own; the rebuild also enqueues scoped cache purges.
   Wait out the minute before reopening writes.

For an off-site record copy, use `wrangler d1 export`. Cloudflare does not
support exporting a database that contains virtual tables, and `products_fts`
is an FTS5 virtual table: a plain export of this database fails with
`cannot export databases with Virtual Tables (fts5)` (verified against the
local database). Export per table instead, skipping every `products_fts*`
table, for example:

```sh
cd web
npx wrangler d1 export store-db --remote --table products --output products.sql
```

Repeat for each application table (list them with
`npx wrangler d1 execute store-db --remote --command "SELECT name FROM sqlite_master WHERE type='table'"`).
Skip `d1_migrations`, `_cf_KV`, `_cf_METADATA`, `sqlite_sequence`, and every
`products_fts*` table. These exports are records for inspection and manual
recovery work; they are not a restore mechanism.

Removing the old `BACKUPS` R2 binding does not delete the existing
`store-backups` buckets. The account owner deletes those manually in the
Cloudflare dashboard when they are no longer needed.

## Verify

Run `npm test` and `npm run lint` from the root. From `web`, run `npm run check`
and `npm run check:migrations`. HTTP, browser and load checks require a running
local server; see the web README for commands.

The maintained application, Wrangler configuration and migration chain are in
`web`; the root package provides tooling and delegates application commands.
The historical root API was removed during the architecture refactor.

See [web/REMEDIATION.md](web/REMEDIATION.md) for the issue, implementation and
verification ledger. Local evidence does not establish Stripe subscriptions,
custom-domain cache hits, deployed performance or the reconciliation soak.

### Focused reclamation checkpoint

Run `npm run verify:reclamation -- C:/path/to/log-folder` from the root for the
focused reclamation suite, lint on its files, typecheck, migration drift and
format checks. Each child command records its native exit code and stops the
runner on failure. This is not a full-suite, 100k or deployment acceptance gate.
`web/scripts/load-gate.mjs` is a public-rendering latency sample only; its obsolete
checkout probe was removed because rejected requests did not prove stock safety.

Migration 0012 adds durable catalog reclamation; it is applied locally only.
Cleanup resumes through the existing catalog queue, protects current and retained
history, and preserves retry state on KV deletion failures. See [SCALING](docs/SCALING.md) for its
retention and operational limits.

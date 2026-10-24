# Store web

A single-store commerce app built with TanStack Start and Cloudflare Workers.
D1 owns commerce data; KV contains derived catalog snapshots; R2 stores media.
Stripe Checkout collects payments. Staff use Better Auth and 2FA.

## Run locally

Use Node 24 and the committed lockfiles. From the repository root:

```sh
npm ci
cd web
npm ci
npm run setup
npm run dev -- --port 8799
```

`setup` generates bindings, applies the complete local migration chain, and
seeds demo products and content. It never migrates a remote database. Put local
secrets in `.dev.vars`; never commit them. Missing Stripe configuration blocks
checkout with HTTP 503. Configure a shipping zone and an explicit rate in
**Admin → Shipping**; a configured $0 rate enables free shipping.

To create the local owner, run `npm run bootstrap:owner` and enter the email
and password when prompted. Sign in and enable 2FA before opening the admin.
Localhost works with `DEV_TRUSTED_ORIGINS` unset. For a local Tunnel, copy the
commented line in `.env.example` to gitignored `.env.local`, uncomment it, and
set it to the exact Tunnel origin. Use comma-separated origins for several hosts, then restart
Vite. Wildcards, paths and credentials are rejected. This nonsecret setting uses
Vite's documented `loadEnv`; secrets stay in `.dev.vars`. Select
`WRANGLER_REMOTE=0` when bootstrapping through the Tunnel.

**Admin → Settings → Store limits** controls open-checkout caps, cart sizes,
order units, Checkout Session duration, refund attempts and stuck-refund alerts.
Defaults are 5 checkouts per email/account and 10 per network per hour, 99 units
per line, 50 lines, 500 order units, a 32-minute Session, 5 refund attempts and
a 60-minute alert threshold. Session duration allows 32–1440 minutes. Zod and
D1 enforce these bounds; missing rows use defaults. New attempts create no stock
or coupon holds before payment authorization. After authorization, D1 allocates
stock/coupon capacity atomically before Stripe capture. Uncertain capture keeps
its allocation until provider state establishes the outcome. The fixed 23-hour
creation/retry horizon protects against Stripe's 24-hour idempotency-key pruning.

## Verify

From the repository root, run `npm test` and `npm run lint`. From `web`, run:

```sh
npm run cf-typegen
npm run check
npm run check:migrations
node scripts/verify-tracer.mjs
node scripts/verify-http.mjs
node scripts/reconcile.mjs
node scripts/load-test.mjs
```

The HTTP and load scripts require the local dev server. `verify-http` creates
and removes isolated local identity fixtures; it never calls Stripe or sends
customer messages. `reconcile` checks local invariants unless `--stripe` is
explicitly supplied with a key. Local runs do not count toward a deployed soak.

## Operate

See [LAUNCH.md](../docs/archive/LAUNCH.md) for deployment prerequisites, subscriptions and
acceptance gates; the root README's "Backups and recovery" section for
D1 Time Travel restore and per-table export; and
[REMEDIATION.md](../docs/archive/REMEDIATION.md) for implementation and verification evidence.
The HTML Cache API requires a custom domain or route; workers.dev cannot prove
this cache design works. No remote operation is part of local setup.

## Payment review and delivery

Shipping/address and promo selection belong to the app. Review shows Stripe's
complete subtotal, discount, shipping, tax and total before Confirm and pay.
Cards and eligible card wallets authorize on Stripe; delayed/installment methods
are excluded. Session completion alone does not mean paid. No polling is added.
Cart conversion happens only after finalization and only if the submitted cart
revision is unchanged; later edits survive.

Public R2 delivery is optional. Leave media_public_base_url unset to retain the
local /media route. A separately authorized deployment can add PUBLIC_MEDIA,
MEDIA_ZONE_ID and MEDIA_PURGE_TOKEN before enabling the HTTPS base URL in admin.
Published originals/variants use immutable keys. Actual uploaded variant
manifests select URLs; pending deletion records stay available for manual retry
until both storage deletion and CDN purge succeed. Do not delete the pending
record or remove its purge configuration to bypass a failed deletion.

0013–0015 are now applied locally with explicit approval and a verified backup. The verified Wrangler backup and migration results are in `docs/archive/REMEDIATION.md`;
the next phase verifies fresh/populated paths and the new lifecycle. The old
layout-setting compatibility reader does not make the new schema optional.

Local development: keep one Vite/workerd instance per persistence directory.
Use --strictPort when starting a designated port so a second launch fails instead
of silently moving to another origin. Stripe CLI forwarding must target that
actual port and /api/webhooks/stripe; the helper's --print output uses the complete
manifest. Stop duplicate servers before investigating local D1 storage errors.

### Checkout hardening checkpoint

Hosted Stripe Checkout remains the approved payment interface. The current
working-tree hardening changes require prepared migration 0016 and have not yet
been tested or applied locally. Before using them, complete the separate
verification/migration checkpoint in [CHECKOUT-HARDENING.md](../docs/archive/CHECKOUT-HARDENING.md).
Existing media publication is an explicit **Admin → Media → Publish existing
media** action after public storage and purge configuration; changing the media
base URL does not start a migration automatically.

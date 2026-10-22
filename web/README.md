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
order units, checkout holds, refund attempts and stuck-refund alerts. Defaults
remain 5 checkouts per email/account and 10 per network per hour, 99 units per
line, 50 lines, 500 order units, a 42-minute hold, 5 refund attempts and a
60-minute alert threshold. Zod and D1 enforce the bounds shown in the form;
missing rows use these defaults. Holds allow 42–1450 minutes: Stripe sessions
expire ten minutes earlier (32–1440 minutes), leaving two minutes above Stripe's
minimum for session creation. The 23-hour refund creation retry cutoff stays
fixed because Stripe can prune idempotency keys after 24 hours.

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

See [LAUNCH.md](LAUNCH.md) for deployment prerequisites, subscriptions and
acceptance gates; the root README's "Backups and recovery" section for
D1 Time Travel restore and per-table export; and
[REMEDIATION.md](REMEDIATION.md) for implementation and verification evidence.
The HTML Cache API requires a custom domain or route; workers.dev cannot prove
this cache design works. No remote operation is part of local setup.

# TanStack skills audit

Audited every file under `web/src` against the installed TanStack skills
(`tanstack-skills/tanstack-skills`, all 14) on 2026-10-18. Method: read the
`tanstack-router` and `tanstack-start` skill bodies, ran a per-file pattern
sweep (server-fn validators, not-found components, search validation, head
coverage, raw internal hrefs), and read every route body the sweep flagged.

## Skill applicability

| Skill                                                                          | Verdict                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tanstack-start                                                                 | Applied. GET `createServerFn` loaders co-located with routes, typed `.validator` on slug/search inputs, file API routes under `routes/api`, `Register` module declaration in `router.tsx`. The skill's `app.config.ts`/Vinxi examples predate the installed Start 1.169; the Vite plugin setup in `vite.config.ts` is the current API.                                                |
| tanstack-router                                                                | Applied. File-based routing, `defaultPreload: 'intent'`, `defaultPendingComponent`, `defaultPreloadStaleTime: 10_000` (stock data stales fast), root `notFoundComponent`/`errorComponent` plus per-route not-found on all `$slug` routes, `loaderDeps` + `validateSearch` on `/search` and `/checkout/success`, `staleTime: 60_000` only on the root layout (store name/collections). |
| tanstack-query                                                                 | Not used, deliberately. Route loaders are the data layer; adding Query would duplicate caching with no consumer. Revisit if client-side refetching appears.                                                                                                                                                                                                                           |
| tanstack-table                                                                 | Not used. Admin tables are small server-rendered lists (<=100 rows) with three actions; headless table state would add a dependency for no behaviour.                                                                                                                                                                                                                                 |
| tanstack-form                                                                  | Not used. Admin forms are single-purpose controlled inputs posting to `/api/admin`; validation lives on the server where it is enforced.                                                                                                                                                                                                                                              |
| tanstack-virtual                                                               | Not needed at current list sizes (<=100 rows, no long scroll surfaces).                                                                                                                                                                                                                                                                                                               |
| tanstack-pacer                                                                 | Not needed. Search is submit-driven; no keystroke streams to debounce.                                                                                                                                                                                                                                                                                                                |
| tanstack-store, tanstack-db                                                    | Not applicable. State is D1 on the server and React state on the client by design.                                                                                                                                                                                                                                                                                                    |
| tanstack-ai, tanstack-ranger, tanstack-devtools, tanstack-cli, tanstack-config | Not applicable to this codebase (no AI features, range inputs, or library publishing). Devtools were considered and skipped to keep the production bundle lean.                                                                                                                                                                                                                       |

## Per-file findings

- `routes/__root.tsx`: root layout with `staleTime`, not-found and error
  components, navigation progress. Pattern sweep flags `font-mono` removal
  already applied (error detail is plain text).
- `routes/index.tsx`: GET loader parallelizes products/settings/collections/
  posts (`Promise.all`). No raw internal hrefs; anchors are in-page only.
- `routes/products/$slug.tsx`, `blog/$slug.tsx`, `collections/$slug.tsx`,
  `pages/$slug.tsx`: loaders `throw notFound()` and each route now declares a
  specific `notFoundComponent` (`components/NotFound.tsx`).
- `routes/search.tsx`, `routes/checkout/success.tsx`: `validateSearch` plus
  narrow `loaderDeps` (only the params the loader uses).
- `routes/auth/index.tsx`: `beforeLoad` redirect to `/auth/sign-in` (the
  Start skill's route-guard pattern).
- `routes/admin/*`: every loader wrapped in `staffLoader` so staff-check
  failures redirect to sign-in instead of a 500. Admin index loader runs its
  seven queries in parallel.
- `routes/api/*`: server handlers only. `reports` and `media` return 403 for
  non-staff instead of throwing; `returns` authenticates the customer and
  checks order ownership; `webhooks/stripe` verifies signatures before any
  state change.
- `routes/media/$key.ts`, `robots.txt.ts`, `sitemap.xml.ts`: server routes,
  correctly headless (the sweep's `no-head` flags are expected here).
- `server/*`, `db/*`, `lib/*`, `do/realtime.ts`: no routing surface.
  `db/client` + `db/schema` are live (Better Auth Drizzle adapter), not dead
  code. `/ws` is staff-gated in `server.ts` before the Durable Object.

## Fixed during the wider audit (same release)

Reports CSV links pointed at non-existent report types; discounts page
queried a non-existent table; shipping UI called unimplemented admin
actions; `settings.set` accepted arbitrary keys (currency-lock bypass);
admin dashboard queried non-existent tables/columns; Stripe success URL
404'd; `/ws` accepted anonymous sockets. All fixed and covered in
`DEFECTS.md` history and the launch checklist.
